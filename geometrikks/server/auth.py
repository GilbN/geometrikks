"""Single-admin session-cookie auth.

Import-time safe: nothing here reads settings or env at import time.
The admin password is argon2-hashed once per process in build_auth_state();
the plaintext from env is never kept on the state object.
"""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, cast

from litestar.datastructures import Cookie, MutableScopeHeaders
from litestar.middleware.session.server_side import (
    ServerSideSessionBackend,
    ServerSideSessionConfig,
)
from litestar.security.session_auth import SessionAuth
from litestar.types import Empty
from litestar.utils.dataclass import extract_dataclass_items
from pwdlib import PasswordHash

from geometrikks.lib.session import PENDING_LIFETIME_SECONDS
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from litestar import Request
    from litestar.connection import ASGIConnection
    from litestar.stores.base import Store
    from litestar.types import Message, ScopeSession

    from geometrikks.config.settings import Settings

logger = get_logger(__name__)

# Paths that never require a session:
# - NON_API_PATTERN matches everything that is not /api, /ws, or under them
#   (the SPA shell, its assets, /health, /schema, /favicon...). The SPA must
#   load unauthenticated so it can render the login page; /ws is *excluded
#   from the exclusion* so the live-feed handshake is authenticated like an
#   API request. The (/|$) boundary keeps bare "/ws" and "/api" authenticated
#   too, not just their slash-suffixed children. Shared by the auth
#   middleware and the session middleware below.
# - /auth/login, /auth/options, and the OIDC routes /auth/oidc/start and
#   /auth/oidc/callback: the pre-login endpoints, reachable before anyone
#   has a session.
NON_API_PATTERN = "^/(?!api(/|$)|ws(/|$))"

AUTH_EXCLUDE_PATTERNS: list[str] = [
    NON_API_PATTERN,
    "^/api/v1/auth/login$",
    "^/api/v1/auth/options$",
    "^/api/v1/auth/oidc/(start|callback)$",
]

SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

# Headroom added on top of PENDING_LIFETIME_SECONDS for the pending session's
# store TTL and cookie max-age. Without it, the store entry expires at the
# exact instant PendingLogin.expired() starts returning True, so a callback
# that lands right around that boundary finds no session at all and is
# logged as state_mismatch instead of the more accurate pending_expired.
PENDING_SESSION_HEADROOM_SECONDS = 60

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
    sessions alive indefinitely. Writing only on change stops most of that,
    but a write of a session that legitimately changed (an authenticated
    request that touches request.session, such as /oidc/start merging
    oidc_pending) still needs handling: _store_loaded_session keeps the
    store's remaining lifetime instead of resetting it, so the expiry set at
    login stays absolute, and if the entry vanished or is effectively
    expired (a concurrent logout, or under a second left) it clears the
    session instead of writing a fresh one back under the old id. A rotated
    or brand-new session id, which has nothing stored yet, still gets the
    full max_age.

    A third change: a session with no "username" key is a pre-login session
    (currently only the OIDC PendingLogin planted by /oidc/start, which is
    unauthenticated and reachable by anyone). Those get a short lifetime
    instead of the configured max_age, both in the store and on the cookie;
    see _store_pending_session for why.
    """

    def __init__(self, config: ServerSideSessionConfig) -> None:
        super().__init__(config)
        self._next_sweep_at = 0.0

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
        rotated = scope.pop(_ROTATE_KEY, False)
        if rotated:
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

        if isinstance(scope_session, dict) and "username" not in scope_session:
            await self._store_pending_session(scope_session, message, connection)
            return

        if loaded and not rotated:
            # A write under the id this request loaded its session from
            # (not a fresh login, which rotates first): go through the
            # store-lifetime-preserving path rather than the stock set(),
            # which would hand it a fresh max_age.
            await self._store_loaded_session(scope_session, message, connection)
            return

        await super().store_in_message(scope_session, message, connection)

    async def _write_session(
        self,
        session_id: str,
        scope_session: "ScopeSession",
        message: "Message",
        connection: "ASGIConnection",
        *,
        expires_in: int,
    ) -> None:
        """Write scope_session to the store under session_id, with a cookie that matches exactly.

        Shared by the pending-session and loaded-and-changed paths so the
        cookie's advertised Max-Age can never drift from the store's actual
        expiry: a browser holding a cookie that outlives its store entry is
        harmless (the next request just 401s), but the reverse, a cookie
        that expires before the session does, would log someone out early
        for no reason.
        """
        scope = connection.scope
        store = self.config.get_store_from_app(scope["app"])
        headers = MutableScopeHeaders.from_message(message)
        cookie_params = dict(
            extract_dataclass_items(self.config, exclude_none=True, include=Cookie.__dict__.keys())
        )
        cookie_params["max_age"] = expires_in
        serialised_data = self.serialize_data(scope_session, scope)
        await store.set(session_id, serialised_data, expires_in=expires_in)
        headers.add(
            "Set-Cookie",
            Cookie(value=session_id, key=self.config.key, **cookie_params).to_header(header=""),
        )

    async def _store_loaded_session(
        self, scope_session: "ScopeSession", message: "Message", connection: "ASGIConnection"
    ) -> None:
        """Write back a session that was loaded from the store under this id.

        Keeps the store's remaining lifetime exactly, so a write triggered by
        an authenticated request that merely touches request.session (like
        /oidc/start merging oidc_pending into an already-logged-in session)
        cannot push the absolute expiry set at login back out to a fresh
        max_age. If the entry disappeared since it was loaded (logout raced
        this request) or its remaining lifetime is at or below zero
        (MemoryStore.expires_in truncates fractions, so under a second left
        reads as 0), the session is gone either way: clear it the same way
        the anonymous-failure path does, instead of writing a new entry back
        under an id that logout, or expiry, already invalidated.
        """
        store = self.config.get_store_from_app(connection.scope["app"])
        session_id = self.get_session_id(connection)
        remaining = await store.expires_in(session_id)
        if scope_session is Empty or remaining is None or remaining <= 0:
            await super().store_in_message(Empty, message, connection)
            return
        await self._write_session(session_id, scope_session, message, connection, expires_in=remaining)

    async def _store_pending_session(
        self, scope_session: dict[str, Any], message: "Message", connection: "ASGIConnection"
    ) -> None:
        """Write a pre-login session with a short lifetime, and sweep the store.

        /oidc/start is the only unauthenticated route that writes a session,
        and it runs before the auth middleware has anything to check, so
        every anonymous hit reaches here. Left on the stock code path it
        would get the full config max_age (SESSION_MAX_AGE_SECONDS, 7 days)
        in both the store and the cookie, even though the PendingLogin it
        holds is worthless after PENDING_LIFETIME_SECONDS. MemoryStore (and
        FileStore) only drop expired rows when read, never on a schedule, so
        a loop of anonymous starts would grow the store without bound
        between accesses. Writing a short lifetime bounds each entry's own
        cost; the sweep below, thrown in on the same path since it is the
        one place every pending write passes through in every app mode
        (including DB-degraded, where the scheduler never starts), clears
        out rows nobody comes back to read.

        The store TTL and cookie max-age get PENDING_SESSION_HEADROOM_SECONDS
        on top of PENDING_LIFETIME_SECONDS: PendingLogin.expired() still uses
        the shorter figure, so without the headroom the store entry would
        vanish at the exact moment expired() starts returning True, and the
        callback would report state_mismatch instead of pending_expired for
        a user who was simply slow.
        """
        session_id = self.get_session_id(connection)
        pending_ttl = PENDING_LIFETIME_SECONDS + PENDING_SESSION_HEADROOM_SECONDS
        await self._write_session(session_id, scope_session, message, connection, expires_in=pending_ttl)
        store = self.config.get_store_from_app(connection.scope["app"])
        await self._sweep_expired_if_due(store)

    async def _sweep_expired_if_due(self, store: "Store") -> None:
        """At most once per PENDING_LIFETIME_SECONDS, drop expired store rows.

        Two requests racing past the throttle and both sweeping is harmless,
        just redundant; the throttle only exists to keep this off the hot
        path on every single request.
        """
        sweep = getattr(store, "delete_expired", None)
        if not callable(sweep):
            return
        now = time.monotonic()
        if now < self._next_sweep_at:
            return
        self._next_sweep_at = now + PENDING_LIFETIME_SECONDS
        await sweep()


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
