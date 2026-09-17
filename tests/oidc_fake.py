"""An in-process OpenID Connect provider for tests.

Serves discovery, authorize, token, JWKS and userinfo with a test RSA key,
reachable through httpx2.ASGITransport. Every knob a test needs to make the
provider misbehave is a field on FakeIdpConfig; the endpoints read the config
on every request, so a test can flip a knob between calls.

The issuer is a loopback http URL so the real settings validation accepts it
without TLS. ASGITransport ignores the host anyway.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass, field
from functools import cache
from typing import Annotated, Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

import httpx2
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from litestar import Litestar, Request, Response, get, post
from litestar.enums import RequestEncodingType
from litestar.params import Body
from litestar.response import Redirect

ISSUER = "http://127.0.0.1:9"
CLIENT_ID = "geometrikks"
CLIENT_SECRET = "test-client-secret"
REDIRECT_URI = "http://localhost/api/v1/auth/oidc/callback"
# 32 bytes: PyJWT warns (InsecureKeyLengthWarning) below that length for
# HS256, and pyproject.toml turns warnings into test failures. HS256 is
# never in ALLOWED_ALGORITHMS, so this signs a token the client must
# reject; only the length matters, not the value.
HS256_SHARED_SECRET = "shared-secret-at-least-32-bytes!"


@cache
def _rsa_keys() -> tuple[rsa.RSAPrivateKey, rsa.RSAPrivateKey]:
    """The key the JWKS serves, and one it never serves."""
    return (
        rsa.generate_private_key(public_exponent=65537, key_size=2048),
        rsa.generate_private_key(public_exponent=65537, key_size=2048),
    )


def _pem(key: rsa.RSAPrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


@dataclass
class FakeIdpConfig:
    issuer: str = ISSUER
    endpoint_scheme: str = "http"
    endpoint_host: str = "127.0.0.1:9"
    advertise_end_session: bool = True
    advertised_algorithms: list[str] = field(default_factory=lambda: ["RS256"])
    token_auth_methods: list[str] | None = None
    kid: str = "key-1"
    token_kid: str | None = None
    signing: str = "rsa"  # rsa | none | hs256 | rsa-other
    claims: dict[str, Any] = field(default_factory=dict)
    expires_in: int = 300
    iat_offset: int = 0
    subject: str = "user-1"
    token_type: str = "Bearer"
    include_id_token: bool = True
    token_response_json: bool = True
    userinfo: dict[str, Any] = field(
        default_factory=lambda: {
            "sub": "user-1",
            "email": "gil@example.com",
            "email_verified": True,
            "preferred_username": "gil",
            "groups": ["admins"],
        }
    )
    fail: dict[str, int] = field(default_factory=dict)
    oversized: set[str] = field(default_factory=set)
    authorize_requests: list[dict[str, str]] = field(default_factory=list)
    token_requests: list[dict[str, str]] = field(default_factory=list)
    jwks_fetches: int = 0
    discovery_fetches: int = 0
    codes: dict[str, dict[str, str]] = field(default_factory=dict)

    def url(self, path: str) -> str:
        return f"{self.endpoint_scheme}://{self.endpoint_host}{path}"


def _failure(config: FakeIdpConfig, name: str) -> Response | None:
    status = config.fail.get(name)
    if status is not None:
        headers = {"Location": config.url("/elsewhere")} if 300 <= status < 400 else {}
        return Response(content=b"", status_code=status, headers=headers)
    if name in config.oversized:
        return Response(content=b"{" + b" " * (70 * 1024), media_type="application/json")
    return None


def mint_id_token(config: FakeIdpConfig, *, nonce: str | None) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": config.issuer,
        "sub": config.subject,
        "aud": CLIENT_ID,
        "exp": now + config.expires_in,
        "iat": now + config.iat_offset,
    }
    if nonce is not None:
        payload["nonce"] = nonce
    payload.update(config.claims)
    headers = {"kid": config.token_kid if config.token_kid is not None else config.kid}
    primary, other = _rsa_keys()
    if config.signing == "none":
        return jwt.encode(payload, key=None, algorithm="none", headers=headers)  # ty: ignore[invalid-argument-type]
    if config.signing == "hs256":
        return jwt.encode(payload, key=HS256_SHARED_SECRET, algorithm="HS256", headers=headers)
    key = other if config.signing == "rsa-other" else primary
    return jwt.encode(payload, key=_pem(key), algorithm="RS256", headers=headers)


def _issue(config: FakeIdpConfig, params: dict[str, str]) -> str:
    """Record an authorize request, mint a code, return the callback URL."""
    config.authorize_requests.append(params)
    code = secrets.token_urlsafe(16)
    config.codes[code] = params
    return f"{params['redirect_uri']}?{urlencode({'code': code, 'state': params['state']})}"


def _client_authenticated(request: Request, data: dict[str, str]) -> bool:
    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        decoded = base64.b64decode(header[6:]).decode()
        client_id, _, secret = decoded.partition(":")
        return (unquote(client_id), unquote(secret)) == (CLIENT_ID, CLIENT_SECRET)
    return (data.get("client_id"), data.get("client_secret")) == (CLIENT_ID, CLIENT_SECRET)


def create_fake_idp(config: FakeIdpConfig) -> Litestar:
    @get("/.well-known/openid-configuration", sync_to_thread=False)
    def discovery() -> Response:
        config.discovery_fetches += 1
        if (failure := _failure(config, "discovery")) is not None:
            return failure
        document: dict[str, Any] = {
            "issuer": config.issuer,
            "authorization_endpoint": config.url("/authorize"),
            "token_endpoint": config.url("/token"),
            "jwks_uri": config.url("/jwks"),
            "userinfo_endpoint": config.url("/userinfo"),
            "id_token_signing_alg_values_supported": config.advertised_algorithms,
        }
        if config.advertise_end_session:
            document["end_session_endpoint"] = config.url("/end-session")
        if config.token_auth_methods is not None:
            document["token_endpoint_auth_methods_supported"] = config.token_auth_methods
        return Response(content=document)

    @get("/authorize", sync_to_thread=False)
    def authorize(request: Request) -> Response:
        if (failure := _failure(config, "authorize")) is not None:
            return failure
        return Redirect(_issue(config, dict(request.query_params)))

    @post("/token", status_code=200, sync_to_thread=False)
    def token(
        request: Request,
        data: Annotated[dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
    ) -> Response:
        config.token_requests.append(
            {**data, "authorization": request.headers.get("authorization", "")}
        )
        if (failure := _failure(config, "token")) is not None:
            return failure
        if not _client_authenticated(request, data):
            return Response(content={"error": "invalid_client"}, status_code=401)
        issued = config.codes.pop(data.get("code", ""), None)
        if (
            issued is None
            or data.get("grant_type") != "authorization_code"
            or data.get("redirect_uri") != issued["redirect_uri"]
        ):
            return Response(content={"error": "invalid_grant"}, status_code=400)
        digest = hashlib.sha256(data.get("code_verifier", "").encode()).digest()
        if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != issued.get("code_challenge"):
            return Response(content={"error": "invalid_grant", "detail": "pkce"}, status_code=400)
        if not config.token_response_json:
            return Response(content=b"access_token=x&token_type=bearer", media_type="text/plain")
        body: dict[str, Any] = {
            "access_token": f"access-{secrets.token_hex(8)}",
            "token_type": config.token_type,
            "expires_in": config.expires_in,
        }
        if config.include_id_token:
            body["id_token"] = mint_id_token(config, nonce=issued.get("nonce"))
        return Response(content=body)

    @get("/jwks", sync_to_thread=False)
    def jwks() -> Response:
        config.jwks_fetches += 1
        if (failure := _failure(config, "jwks")) is not None:
            return failure
        primary, _ = _rsa_keys()
        key = RSAAlgorithm.to_jwk(primary.public_key(), as_dict=True)
        return Response(content={"keys": [{**key, "kid": config.kid, "use": "sig", "alg": "RS256"}]})

    @get("/userinfo", sync_to_thread=False)
    def userinfo(request: Request) -> Response:
        if (failure := _failure(config, "userinfo")) is not None:
            return failure
        if not request.headers.get("authorization", "").startswith("Bearer access-"):
            return Response(content={"error": "invalid_token"}, status_code=401)
        return Response(content=config.userinfo)

    return Litestar(
        route_handlers=[discovery, authorize, token, jwks, userinfo], logging_config=None
    )


@dataclass
class FakeIdp:
    config: FakeIdpConfig
    app: Litestar

    def http_client(self) -> httpx2.AsyncClient:
        """An httpx2 client whose transport routes into the fake app."""
        return httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=self.app),  # ty: ignore[invalid-argument-type]
            follow_redirects=False,
        )

    def issue_code(self, authorize_url: str) -> str:
        """Play the browser without HTTP: return the callback path plus query.

        Path form on purpose: the Litestar test client scopes cookies to its
        own host, so an absolute callback URL on another host would drop the
        session cookie.
        """
        params = dict(parse_qsl(urlsplit(authorize_url).query))
        callback = urlsplit(_issue(self.config, params))
        return f"{callback.path}?{callback.query}"

    async def visit_authorize(self, authorize_url: str) -> str:
        """Play the browser over HTTP: return the absolute callback URL."""
        async with self.http_client() as http:
            response = await http.get(authorize_url)
        assert response.status_code == 302, response.text
        return response.headers["location"]


def make_fake_idp(config: FakeIdpConfig | None = None) -> FakeIdp:
    config = config or FakeIdpConfig()
    return FakeIdp(config=config, app=create_fake_idp(config))
