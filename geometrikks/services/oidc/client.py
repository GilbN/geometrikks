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
import json
import ssl
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx2
import jwt

from geometrikks.lib.urls import validate_https_url
from geometrikks.server.logging import get_logger
from geometrikks.services.oidc.errors import OidcProtocolError, OidcUnavailable

if TYPE_CHECKING:
    from geometrikks.config.settings import OidcSettings

logger = get_logger(__name__)

MAX_TOKEN_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024
CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 10.0
LEEWAY_SECONDS = 60
PENDING_LIFETIME_SECONDS = 10 * 60
ALLOWED_ALGORITHMS = frozenset(
    {"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"}
)
_REQUIRED_METADATA = ("authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint")


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
