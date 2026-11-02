"""Bearer API keys, checked by the same auth middleware as the session cookie."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, NoReturn

from litestar.enums import ScopeType
from litestar.exceptions import NotAuthorizedException, PermissionDeniedException, ServiceUnavailableException
from litestar.middleware.authentication import AuthenticationResult
from litestar.middleware.session.server_side import ServerSideSessionBackend
from litestar.openapi.spec import Components, SecurityScheme
from litestar.security.session_auth import SessionAuth, SessionAuthMiddleware

from geometrikks.domain.auth.api_keys import (
    display_prefix_of,
    is_api_key_token,
    is_well_formed_api_key,
)
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server import runtime
from geometrikks.server.auth import AdminUser
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger

if TYPE_CHECKING:
    from uuid import UUID

    from litestar.config.app import AppConfig
    from litestar.connection import ASGIConnection
    from litestar.handlers import BaseRouteHandler

    from geometrikks.domain.auth.api_keys import ApiKeyScope
    from geometrikks.server.api_key_store import ApiKeyStore

login_logger = get_logger(LOGIN_LOGGER_NAME)

API_KEY_SECURITY_SCHEME = "apiKey"
READ_ONLY_METHODS = frozenset({"GET", "HEAD"})

RejectionReason = Literal["malformed", "unknown", "expired"]


@dataclass(frozen=True)
class ApiKeyPrincipal:
    """request.user for a request authenticated by an API key."""

    key_id: UUID
    name: str
    scope: ApiKeyScope


def bearer_tokens(connection: ASGIConnection[Any, Any, Any, Any]) -> list[str]:
    """Every ``Bearer`` token the request carries, any case and padding.

    Repeated Authorization headers and comma-joined credentials are all read.
    Reading only the first would let a proxy's JWT placed ahead of a Read key
    hide the key and hand the request to the cookie.
    """
    tokens: list[str] = []
    for authorization in connection.headers.getall("authorization", []):
        for credential in authorization.split(","):
            scheme_and_token = credential.split(maxsplit=1)
            if len(scheme_and_token) == 2 and scheme_and_token[0].lower() == "bearer":
                tokens.append(scheme_and_token[1].strip())
    return tokens


class ApiKeyAuthMiddleware(SessionAuthMiddleware):
    """A ``gmk_`` bearer token decides the request. Anything else takes the cookie path.

    The key path never assigns ``connection.scope["session"]``, on failure
    either. The session middleware has already loaded the cookie's session,
    and RotatingServerSideSessionBackend deletes a loaded session that is set
    to Empty, so a bad key sent next to a valid cookie would log the browser out.
    """

    async def authenticate_request(self, connection: ASGIConnection[Any, Any, Any, Any]) -> AuthenticationResult:
        api_key_tokens = [token for token in bearer_tokens(connection) if is_api_key_token(token)]
        if not api_key_tokens:
            return await super().authenticate_request(connection)
        store = runtime.get_api_key_store(connection.app)
        if store is None:
            raise ServiceUnavailableException(detail="API keys are unavailable.")
        token = api_key_tokens[0]
        if len(api_key_tokens) > 1 or not is_well_formed_api_key(token):
            self._reject(store, connection, token, "malformed")
        api_key_record = await store.authenticate(token)
        if api_key_record is None:
            self._reject(store, connection, token, "unknown")
        if api_key_record.is_expired(store.clock()):
            self._reject(store, connection, token, "expired", key_name=api_key_record.name)
        await store.record_use(api_key_record, resolve_client_ip(connection))
        principal = ApiKeyPrincipal(key_id=api_key_record.id, name=api_key_record.name, scope=api_key_record.scope)
        return AuthenticationResult(user=principal, auth=None)

    @staticmethod
    def _reject(
        store: ApiKeyStore,
        connection: ASGIConnection[Any, Any, Any, Any],
        token: str,
        reason: RejectionReason,
        *,
        key_name: str | None = None,
    ) -> NoReturn:
        display_prefix = display_prefix_of(token)
        client_ip = resolve_client_ip(connection)
        if store.should_log_rejection(display_prefix, client_ip):
            key_field = {} if key_name is None else {"key": key_name}
            login_logger.warning("api_key_rejected", user=display_prefix, ip=client_ip, reason=reason, **key_field)
        raise NotAuthorizedException("API key expired" if reason == "expired" else "Invalid API key")


class GeoSessionAuth(SessionAuth[AdminUser | ApiKeyPrincipal, ServerSideSessionBackend]):
    """Adds the bearer key scheme to OpenAPI. The top-level security accepts it or the session cookie."""

    @property
    def openapi_components(self) -> Components:
        security_schemes = dict(super().openapi_components.security_schemes or {})
        security_schemes[API_KEY_SECURITY_SCHEME] = SecurityScheme(
            type="http",
            scheme="bearer",
            description="An API key from Settings, sent as Authorization: Bearer gmk_...",
        )
        return Components(security_schemes=security_schemes)

    def on_app_init(self, app_config: AppConfig) -> AppConfig:
        app_config = super().on_app_init(app_config)
        if app_config.openapi_config is not None:
            app_config.openapi_config.security = [
                *(app_config.openapi_config.security or []),
                {API_KEY_SECURITY_SCHEME: []},
            ]
        return app_config


def api_key_scope_guard(connection: ASGIConnection[Any, Any, Any, Any], _: BaseRouteHandler) -> None:
    """Read keys may only read. WebSocket handshakes count as reads."""
    if "user" not in connection.scope:
        return
    principal = connection.scope["user"]
    if not isinstance(principal, ApiKeyPrincipal) or principal.scope == "read_write":
        return
    if connection.scope["type"] == ScopeType.WEBSOCKET:
        return
    if connection.scope.get("method") not in READ_ONLY_METHODS:
        raise PermissionDeniedException("This API key is read-only")


def requires_session_user(connection: ASGIConnection[Any, Any, Any, Any], _: BaseRouteHandler) -> None:
    if "user" in connection.scope and isinstance(connection.scope["user"], ApiKeyPrincipal):
        raise PermissionDeniedException("API keys cannot use this endpoint")
