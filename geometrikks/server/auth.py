"""Single-admin session-cookie auth.

Import-time safe: nothing here reads settings or env at import time.
The admin password is argon2-hashed once per process in build_auth_state();
the plaintext from env is never kept on the state object.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, cast

from litestar.middleware.session.server_side import (
    ServerSideSessionBackend,
    ServerSideSessionConfig,
)
from litestar.security.session_auth import SessionAuth
from litestar.types import Empty
from pwdlib import PasswordHash

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from litestar import Request
    from litestar.connection import ASGIConnection
    from litestar.types import Message, ScopeSession

    from geometrikks.config.settings import Settings

logger = get_logger(__name__)

# Paths that never require a session:
# - "^/(?!api(/|$)|ws(/|$))" — everything that is not /api, /ws, or under them
#   (the SPA shell, its assets, /health, /schema, /favicon...). The SPA must
#   load unauthenticated so it can render the login page; /ws is *excluded from
#   the exclusion* so the live-feed handshake is authenticated like an API
#   request. The (/|$) boundary keeps bare "/ws" and "/api" authenticated too,
#   not just their slash-suffixed children.
# - the login endpoints and the pre-login options endpoint.
# Everything that is not /api or /ws: the SPA shell, static assets, /health,
# /schema. Shared by the auth middleware and the session middleware below.
NON_API_PATTERN = "^/(?!api(/|$)|ws(/|$))"

AUTH_EXCLUDE_PATTERNS: list[str] = [
    NON_API_PATTERN,
    "^/api/v1/auth/login$",
    "^/api/v1/auth/options$",
    "^/api/v1/auth/oidc/(start|callback)$",
]

SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

Provider = Literal["password", "oidc"]

_ROTATE_KEY = "geometrikks.session.rotate"
_LOADED_KEY = "geometrikks.session.loaded"
_NEW_ID_KEY = "geometrikks.session.new_id"


@dataclass(frozen=True)
class AdminUser:
    """The one and only user. Litestar exposes it as request.user."""

    username: str
    provider: Provider = "password"


_hasher = PasswordHash.recommended()  # argon2id


@dataclass(frozen=True)
class AuthState:
    """Verified-at-startup auth material: username + argon2 hash."""

    username: str
    password_hash: str

    def verify(self, username: str, password: str) -> bool:
        """Constant-time-ish credential check (argon2 verify dominates)."""
        if username != self.username:
            # Still burn a hash verification so the timing side channel
            # doesn't reveal whether the username exists.
            _hasher.verify(password, self.password_hash)
            return False
        return _hasher.verify(password, self.password_hash)


def build_auth_state(settings: "Settings") -> AuthState | None:
    """Hash the env-provided admin password once per process.

    None means password login is off: OIDC is configured and no password is
    set. Neither configured is a startup error.
    """
    if not settings.password_login_enabled:
        if settings.oidc.enabled:
            logger.info("password_login_disabled", reason="APP_ADMIN_PASSWORD unset, OIDC enabled")
            return None
        raise RuntimeError(
            "Auth is enabled but APP_ADMIN_PASSWORD is not set. Set APP_ADMIN_PASSWORD, "
            "configure OIDC_* for single sign-on, or set APP_AUTH_DISABLED=true if an "
            "authenticating reverse proxy fronts this app."
        )
    password = cast("Any", settings.admin_password).get_secret_value()
    auth_state = AuthState(username=settings.admin_user, password_hash=_hasher.hash(password))
    logger.info("auth_state_built", user=settings.admin_user)
    return auth_state


def warn_auth_disabled() -> None:
    logger.warning(
        "auth_disabled",
        detail=(
            "APP_AUTH_DISABLED=true: API is unauthenticated. Only run this "
            "behind an authenticating reverse proxy."
        ),
    )


async def retrieve_user_handler(
    session: dict[str, Any], connection: "ASGIConnection | None" = None
) -> AdminUser | None:
    """Rehydrate request.user from the session dict on every request."""
    username = session.get("username")
    if not username:
        return None
    provider: Provider = "oidc" if session.get("provider") == "oidc" else "password"
    return AdminUser(username=username, provider=provider)


def _scope_dict(connection: "ASGIConnection") -> dict[str, Any]:
    # Scope is a TypedDict; the backend keeps its bookkeeping under
    # namespaced keys that no Litestar code reads.
    return cast("dict[str, Any]", connection.scope)


def rotate_session(request: "Request") -> None:
    """Issue a fresh session id on this response.

    Call before set_session() on every successful login. The id the browser
    arrived with is deleted from the store and never reused, so a cookie
    planted before login cannot survive it.
    """
    _scope_dict(request)[_ROTATE_KEY] = True


class RotatingServerSideSessionBackend(ServerSideSessionBackend):
    """Server-side sessions that rotate on login and write only on change.

    Stock Litestar reuses the incoming session id forever and writes the
    session back on every response, renewing its expiry each time. The
    first is session fixation. The second lets a request that was in flight
    during logout write the deleted session straight back, and keeps active
    sessions alive indefinitely. Writing only on change makes the expiry
    set at login absolute.
    """

    async def load_from_connection(self, connection: "ASGIConnection") -> dict[str, Any]:
        data = await super().load_from_connection(connection)
        _scope_dict(connection)[_LOADED_KEY] = copy.deepcopy(data)
        return data

    def get_session_id(self, connection: "ASGIConnection") -> str:
        forced = _scope_dict(connection).get(_NEW_ID_KEY)
        if isinstance(forced, str):
            return forced
        return super().get_session_id(connection)

    async def store_in_message(
        self, scope_session: "ScopeSession", message: "Message", connection: "ASGIConnection"
    ) -> None:
        scope = _scope_dict(connection)
        loaded = scope.get(_LOADED_KEY)
        if scope.pop(_ROTATE_KEY, False):
            old_id = connection.cookies.get(self.config.key)
            if old_id and old_id != "null":
                store = self.config.get_store_from_app(scope["app"])
                await self.delete(old_id, store=store)
            scope[_NEW_ID_KEY] = self.generate_session_id()
        elif scope_session is Empty and not loaded:
            # Asked to clear a session that never existed: the auth middleware
            # sets Empty on every anonymous failure. Nothing to delete, no
            # cookie to send.
            return
        elif scope_session is not Empty and scope_session == loaded:
            return
        await super().store_in_message(scope_session, message, connection)


class RotatingServerSideSessionConfig(ServerSideSessionConfig):
    """ServerSideSessionConfig whose middleware builds the rotating backend."""

    _backend_class = RotatingServerSideSessionBackend


def create_session_auth(settings: "Settings") -> SessionAuth[AdminUser, ServerSideSessionBackend]:
    """Build the SessionAuth component applied via on_app_init in create_app().

    Server-side sessions with the default in-memory store: an app restart
    invalidates all sessions (users just log in again) — fine for a
    single-admin homelab tool and avoids a signing-secret setting.
    """
    session_auth = SessionAuth[AdminUser, ServerSideSessionBackend](
        retrieve_user_handler=retrieve_user_handler,
        session_backend_config=RotatingServerSideSessionConfig(
            max_age=SESSION_MAX_AGE_SECONDS,
            secure=settings.session_secure,
            # Sessions exist only for /api and /ws. Without this exclusion the
            # session middleware runs on the SPA shell and every static asset,
            # and each response writes the session it loaded at request start
            # back to the store. A slow asset response that started before
            # login (the PWA precache fires dozens concurrently) then
            # overwrites the fresh authenticated session with stale pre-login
            # data, and the next API call 401s: the user bounces from a
            # successful login straight back to /login.
            exclude=NON_API_PATTERN,
        ),
        exclude=AUTH_EXCLUDE_PATTERNS,
    )
    logger.debug("session_auth_configured")
    return session_auth
