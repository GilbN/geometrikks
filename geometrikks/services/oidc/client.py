"""OIDC relying-party client for one identity provider.

Import-time safe: nothing here reads settings. The HTTP client is injected so
tests route it into an in-process fake provider.

The validation rules follow the OIDC provider in litestar-security
(providers/oidc/_provider.py and providers/oauth/_provider.py). Its
private-address pinning is deliberately not adopted: homelab identity
providers live on private addresses.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import ssl
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

import httpx2
import jwt

from geometrikks.lib.session import PENDING_LIFETIME_SECONDS
from geometrikks.lib.urls import validate_https_url
from geometrikks.server.logging import get_logger
from geometrikks.services.oidc.errors import OidcForbidden, OidcProtocolError, OidcUnavailable

if TYPE_CHECKING:
    from geometrikks.config.settings import OidcSettings

logger = get_logger(__name__)

MAX_TOKEN_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024
CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 10.0
LEEWAY_SECONDS = 60
ALLOWED_ALGORITHMS = frozenset(
    {"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"}
)
_REQUIRED_METADATA = ("authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint")

_now = time.time


def _token() -> str:
    """32 random bytes, base64url without padding: 43 characters."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _text(document: Mapping[str, Any], key: str) -> str | None:
    value = document.get(key)
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class PendingLogin:
    """What the start endpoint remembers until the callback arrives."""

    state: str
    nonce: str
    code_verifier: str
    created_at: float

    def to_session(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "nonce": self.nonce,
            "code_verifier": self.code_verifier,
            "created_at": self.created_at,
        }

    @classmethod
    def from_session(cls, data: object) -> PendingLogin | None:
        if not isinstance(data, dict):
            return None
        try:
            return cls(
                state=str(data["state"]),
                nonce=str(data["nonce"]),
                code_verifier=str(data["code_verifier"]),
                created_at=float(data["created_at"]),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def expired(self, now: float | None = None) -> bool:
        current = _now() if now is None else now
        return current - self.created_at > PENDING_LIFETIME_SECONDS

    def matches_state(self, state: str | None) -> bool:
        return isinstance(state, str) and hmac.compare_digest(state.encode(), self.state.encode())


@dataclass(frozen=True)
class OidcIdentity:
    subject: str
    username: str
    email: str | None
    email_verified: bool
    groups: tuple[str, ...]


@dataclass(frozen=True)
class OidcCompletion:
    identity: OidcIdentity
    id_token: str


def build_identity(
    claims: Mapping[str, Any], userinfo: Mapping[str, Any], *, groups_claim: str
) -> OidcIdentity:
    """Merge the ID token and userinfo per document, not per key.

    email and email_verified travel together from whichever document carries
    the email (userinfo first), so a true in one document cannot vouch for an
    address only the other supplied. Authelia serves email and groups from
    userinfo only; Authentik puts them in the ID token.
    """
    subject = _text(claims, "sub")
    if subject is None:
        raise OidcProtocolError("id_token_invalid", "missing sub")
    if _text(userinfo, "sub") != subject:
        raise OidcProtocolError("userinfo", "sub differs from the ID token")
    email_source = userinfo if _text(userinfo, "email") else claims
    other = claims if email_source is userinfo else userinfo
    email = _text(email_source, "email")
    other_email = _text(other, "email")
    if email and other_email and email.lower() != other_email.lower():
        raise OidcProtocolError("claims", "email differs between the ID token and userinfo")
    email_verified = email is not None and email_source.get("email_verified") is True
    # Userinfo wins only when it actually carries a usable value; a provider
    # that sends "groups": null there (rather than omitting the key) must
    # still fall back to the ID token, or its groups are silently discarded.
    raw_groups = userinfo.get(groups_claim) if groups_claim in userinfo else None
    if not isinstance(raw_groups, (list, str)):
        raw_groups = claims.get(groups_claim)
    if isinstance(raw_groups, str):
        raw_groups = [raw_groups]
    groups = tuple(g for g in raw_groups if isinstance(g, str)) if isinstance(raw_groups, list) else ()
    username = subject
    for key in ("preferred_username", "name", "email"):
        found = _text(claims, key) or _text(userinfo, key)
        if found:
            username = found
            break
    return OidcIdentity(
        subject=subject,
        username=username,
        email=email.lower() if email else None,
        email_verified=email_verified,
        groups=groups,
    )


def check_allow_list(
    identity: OidcIdentity, *, allowed_users: Sequence[str], allowed_groups: Sequence[str]
) -> None:
    """Raise OidcForbidden unless subject, verified email or a group matches."""
    if identity.subject in allowed_users:
        return
    emails = {user.lower() for user in allowed_users}
    if identity.email_verified and identity.email is not None and identity.email.lower() in emails:
        return
    if set(identity.groups) & set(allowed_groups):
        return
    raise OidcForbidden(identity.subject, identity.email, identity.groups)


def create_oidc_http_client(settings: OidcSettings) -> httpx2.AsyncClient:
    """The production transport: no redirects, split timeouts, optional CA file."""
    verify: ssl.SSLContext | bool = True
    if settings.ca_bundle is not None:
        verify = ssl.create_default_context(cafile=str(settings.ca_bundle))
    return httpx2.AsyncClient(
        follow_redirects=False,
        timeout=httpx2.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT),
        verify=verify,
    )


@dataclass(frozen=True)
class ProviderMetadata:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    userinfo_endpoint: str
    end_session_endpoint: str | None
    algorithms: frozenset[str]
    token_auth_post: bool


async def _read_bounded(response: httpx2.Response) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise OidcUnavailable(f"response from {response.url} exceeds {MAX_BODY_BYTES} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def _parse_object(body: bytes, *, source: str) -> dict[str, Any]:
    try:
        document = json.loads(body)
    except ValueError as exc:
        raise OidcUnavailable(f"{source} is not JSON") from exc
    if not isinstance(document, dict):
        raise OidcUnavailable(f"{source} is not a JSON object")
    return document


class OidcClient:
    """Discovery, JWKS and the login round trip against one provider."""

    def __init__(self, settings: OidcSettings, http: httpx2.AsyncClient) -> None:
        self._settings = settings
        self._http = http
        self._metadata: ProviderMetadata | None = None
        self._jwks: jwt.PyJWKSet | None = None
        self._lock = asyncio.Lock()
        self.last_error: str | None = None

    @property
    def metadata_cached(self) -> ProviderMetadata | None:
        return self._metadata

    async def metadata(self) -> ProviderMetadata:
        """Fetch discovery once and cache it; a failure is retried next call."""
        if self._metadata is not None:
            return self._metadata
        async with self._lock:
            if self._metadata is not None:
                return self._metadata
            try:
                metadata = await self._discover()
            except OidcUnavailable as exc:
                self.last_error = str(exc)
                logger.warning(
                    "oidc_discovery_failed",
                    issuer=self._settings.issuer,
                    error=type(exc).__name__,
                    detail=str(exc),
                )
                raise
            self._metadata = metadata
            self.last_error = None
            logger.info(
                "oidc_discovery_loaded",
                issuer=metadata.issuer,
                end_session=metadata.end_session_endpoint is not None,
            )
            if self._settings.logout_idp and metadata.end_session_endpoint is None:
                logger.warning("oidc_idp_logout_unsupported", issuer=metadata.issuer)
            return metadata

    async def warm_up(self) -> None:
        """Startup discovery. Never raises; the outcome is on last_error."""
        try:
            await self.metadata()
        except OidcUnavailable:
            pass

    async def aclose(self) -> None:
        await self._http.aclose()

    async def begin(self) -> tuple[str, PendingLogin]:
        """The authorize URL to send the browser to, and what to remember."""
        metadata = await self.metadata()
        pending = PendingLogin(
            state=_token(), nonce=_token(), code_verifier=_token(), created_at=_now()
        )
        params = {
            "response_type": "code",
            "client_id": self._settings.client_id or "",
            "redirect_uri": self._settings.redirect_uri or "",
            "scope": " ".join(self._settings.scope_list),
            "state": pending.state,
            "nonce": pending.nonce,
            "code_challenge": _s256(pending.code_verifier),
            "code_challenge_method": "S256",
        }
        return f"{metadata.authorization_endpoint}?{urlencode(params)}", pending

    async def complete(self, code: str, pending: PendingLogin) -> OidcCompletion:
        """Trade the code for tokens, verify who this is, apply the allow list."""
        metadata = await self.metadata()
        tokens = await self._exchange_code(code, pending, metadata)
        claims = await self._verify_id_token(tokens["id_token"], pending, metadata)
        userinfo = await self._userinfo(tokens["access_token"], metadata)
        identity = build_identity(claims, userinfo, groups_claim=self._settings.groups_claim)
        check_allow_list(
            identity,
            allowed_users=self._settings.allowed_users,
            allowed_groups=self._settings.allowed_groups,
        )
        return OidcCompletion(identity=identity, id_token=tokens["id_token"])

    def end_session_url(self, id_token: str, post_logout_redirect_uri: str) -> str | None:
        """Where to send the browser to end the IdP session; None if unsupported."""
        metadata = self._metadata
        if metadata is None or metadata.end_session_endpoint is None:
            return None
        query = urlencode(
            {
                "id_token_hint": id_token,
                "client_id": self._settings.client_id or "",
                "post_logout_redirect_uri": post_logout_redirect_uri,
            }
        )
        return f"{metadata.end_session_endpoint}?{query}"

    async def _exchange_code(
        self, code: str, pending: PendingLogin, metadata: ProviderMetadata
    ) -> dict[str, str]:
        client_id = self._settings.client_id or ""
        secret = self._settings.client_secret.get_secret_value() if self._settings.client_secret else ""
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self._settings.redirect_uri or "",
            "code_verifier": pending.code_verifier,
        }
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if metadata.token_auth_post:
            data["client_id"] = client_id
            data["client_secret"] = secret
        else:
            # RFC 6749 section 2.3.1: form-encode both halves before base64.
            credentials = f"{quote(client_id, safe='')}:{quote(secret, safe='')}".encode()
            headers["Authorization"] = "Basic " + base64.b64encode(credentials).decode()
        try:
            async with self._http.stream(
                "POST", metadata.token_endpoint, data=data, headers=headers
            ) as response:
                body = await _read_bounded(response)
        except httpx2.HTTPError as exc:
            raise OidcUnavailable(f"token request failed: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise OidcProtocolError(
                "token_exchange", f"token endpoint answered HTTP {response.status_code}"
            )
        try:
            document = _parse_object(body, source="token response")
        except OidcUnavailable as exc:
            raise OidcProtocolError("token_exchange", str(exc)) from exc
        token_type = document.get("token_type")
        if not isinstance(token_type, str) or token_type.lower() != "bearer":
            raise OidcProtocolError("token_exchange", "token_type is not bearer")
        tokens: dict[str, str] = {}
        for name in ("access_token", "id_token"):
            value = document.get(name)
            if not isinstance(value, str) or not value:
                raise OidcProtocolError("token_exchange", f"token response lacks {name}")
            tokens[name] = value
        return tokens

    async def _verify_id_token(
        self, token: str, pending: PendingLogin, metadata: ProviderMetadata
    ) -> dict[str, Any]:
        if len(token.encode()) > MAX_TOKEN_BYTES:
            raise OidcProtocolError("id_token_invalid", "ID token is larger than 16 KiB")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise OidcProtocolError(
                "id_token_invalid", f"unreadable header: {type(exc).__name__}"
            ) from exc
        algorithm, kid = header.get("alg"), header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise OidcProtocolError("id_token_invalid", "header lacks kid")
        if not isinstance(algorithm, str) or algorithm not in metadata.algorithms:
            raise OidcProtocolError("id_token_invalid", f"algorithm {algorithm!r} is not allowed")
        key = await self._signing_key(kid)
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=[algorithm],
                audience=self._settings.client_id,
                issuer=self._settings.issuer,
                leeway=LEEWAY_SECONDS,
                options={"require": ["iss", "sub", "aud", "exp", "iat"]},
            )
        except jwt.PyJWTError as exc:
            raise OidcProtocolError("id_token_invalid", type(exc).__name__) from exc
        if not _text(claims, "sub"):
            raise OidcProtocolError("id_token_invalid", "empty sub")
        audience = claims["aud"]
        audiences = audience if isinstance(audience, list) else [audience]
        azp = claims.get("azp")
        if azp is not None and azp != self._settings.client_id:
            raise OidcProtocolError("id_token_invalid", "azp is not this client")
        if len(audiences) > 1 and azp is None:
            raise OidcProtocolError("id_token_invalid", "several audiences without azp")
        nonce = claims.get("nonce")
        if not isinstance(nonce, str) or not hmac.compare_digest(
            nonce.encode(), pending.nonce.encode()
        ):
            raise OidcProtocolError("nonce_mismatch", "nonce does not match this login")
        return claims

    async def _userinfo(self, access_token: str, metadata: ProviderMetadata) -> dict[str, Any]:
        try:
            return await self._get_json(
                metadata.userinfo_endpoint,
                source="userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
        except OidcUnavailable as exc:
            raise OidcProtocolError("userinfo", str(exc)) from exc

    async def _discover(self) -> ProviderMetadata:
        issuer = (self._settings.issuer or "").rstrip("/")
        document = await self._get_json(
            f"{issuer}/.well-known/openid-configuration", source="discovery document"
        )
        if document.get("issuer") != self._settings.issuer:
            raise OidcUnavailable(
                f"discovery issuer {document.get('issuer')!r} does not match OIDC_ISSUER"
            )
        endpoints: dict[str, str] = {}
        for name in _REQUIRED_METADATA:
            value = document.get(name)
            if not isinstance(value, str) or not value:
                raise OidcUnavailable(f"discovery document lacks {name}")
            _check_endpoint(value, name)
            endpoints[name] = value
        end_session = document.get("end_session_endpoint")
        if end_session is not None:
            if not isinstance(end_session, str) or not end_session:
                raise OidcUnavailable("end_session_endpoint is not a URL")
            _check_endpoint(end_session, "end_session_endpoint")
        advertised = document.get("id_token_signing_alg_values_supported", ["RS256"])
        algorithms: frozenset[str] = frozenset()
        if isinstance(advertised, list):
            algorithms = frozenset(a for a in advertised if isinstance(a, str)) & ALLOWED_ALGORITHMS
        if not algorithms:
            raise OidcUnavailable(
                "identity provider advertises no supported asymmetric ID token algorithm"
            )
        methods = document.get("token_endpoint_auth_methods_supported")
        token_auth_post = (
            isinstance(methods, list)
            and "client_secret_basic" not in methods
            and "client_secret_post" in methods
        )
        return ProviderMetadata(
            issuer=self._settings.issuer or "",
            authorization_endpoint=endpoints["authorization_endpoint"],
            token_endpoint=endpoints["token_endpoint"],
            jwks_uri=endpoints["jwks_uri"],
            userinfo_endpoint=endpoints["userinfo_endpoint"],
            end_session_endpoint=end_session,
            algorithms=algorithms,
            token_auth_post=token_auth_post,
        )

    async def _get_json(
        self, url: str, *, source: str, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        request_headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        request_headers.update(headers or {})
        try:
            async with self._http.stream("GET", url, headers=request_headers) as response:
                body = await _read_bounded(response)
        except httpx2.HTTPError as exc:
            raise OidcUnavailable(f"{source} request failed: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise OidcUnavailable(f"{source} answered HTTP {response.status_code}")
        return _parse_object(body, source=source)

    async def _fetch_jwks(self) -> jwt.PyJWKSet:
        metadata = await self.metadata()
        document = await self._get_json(metadata.jwks_uri, source="JWKS")
        try:
            self._jwks = jwt.PyJWKSet.from_dict(document)
        except jwt.PyJWTError as exc:
            raise OidcUnavailable(f"JWKS is malformed: {type(exc).__name__}") from exc
        return self._jwks

    async def _signing_key(self, kid: str) -> jwt.PyJWK:
        """The key for ``kid``, refetching the JWKS once on a miss (key rotation)."""
        jwks = self._jwks or await self._fetch_jwks()
        try:
            return jwks[kid]
        except KeyError:
            pass
        jwks = await self._fetch_jwks()
        logger.info("oidc_jwks_refreshed", kid=kid)
        try:
            return jwks[kid]
        except KeyError:
            raise OidcProtocolError("id_token_invalid", f"unknown signing key {kid!r}") from None


def _check_endpoint(value: str, name: str) -> None:
    try:
        validate_https_url(value, name=name)
    except ValueError as exc:
        raise OidcUnavailable(str(exc)) from exc
