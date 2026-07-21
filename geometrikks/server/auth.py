"""Single-admin session-cookie auth.

Import-time safe: nothing here reads settings or env at import time.
The admin password is argon2-hashed once per process in build_auth_state();
the plaintext from env is never kept on the state object.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from litestar.middleware.session.server_side import (
    ServerSideSessionBackend,
    ServerSideSessionConfig,
)
from litestar.security.session_auth import SessionAuth
from pwdlib import PasswordHash

if TYPE_CHECKING:
    from litestar.connection import ASGIConnection

    from geometrikks.config.settings import Settings

# Paths that never require a session:
# - "^/(?!api(/|$)|ws(/|$))" — everything that is not /api, /ws, or under them
#   (the SPA shell, its assets, /health, /schema, /favicon...). The SPA must
#   load unauthenticated so it can render the login page; /ws is *excluded from
#   the exclusion* so the live-feed handshake is authenticated like an API
#   request. The (/|$) boundary keeps bare "/ws" and "/api" authenticated too,
#   not just their slash-suffixed children.
# - the login endpoint itself.
AUTH_EXCLUDE_PATTERNS: list[str] = [
    "^/(?!api(/|$)|ws(/|$))",
    "^/api/v1/auth/login$",
]


@dataclass(frozen=True)
class AdminUser:
    """The one and only user. Litestar exposes it as request.user."""

    username: str


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


def build_auth_state(settings: "Settings") -> AuthState:
    """Hash the env-provided admin password once per process."""
    if settings.admin_password is None or not settings.admin_password.get_secret_value():
        raise RuntimeError(
            "Auth is enabled but APP_ADMIN_PASSWORD is not set. "
            "Set APP_ADMIN_PASSWORD, or set APP_AUTH_DISABLED=true if an "
            "authenticating reverse proxy fronts this app."
        )
    return AuthState(
        username=settings.admin_user,
        password_hash=_hasher.hash(settings.admin_password.get_secret_value()),
    )


async def retrieve_user_handler(
    session: dict[str, Any], connection: "ASGIConnection | None" = None
) -> AdminUser | None:
    """Rehydrate request.user from the session dict on every request."""
    username = session.get("username")
    return AdminUser(username=username) if username else None


def create_session_auth(settings: "Settings") -> SessionAuth[AdminUser, ServerSideSessionBackend]:
    """Build the SessionAuth component applied via on_app_init in create_app().

    Server-side sessions with the default in-memory store: an app restart
    invalidates all sessions (users just log in again) — fine for a
    single-admin homelab tool and avoids a signing-secret setting.
    """
    return SessionAuth[AdminUser, ServerSideSessionBackend](
        retrieve_user_handler=retrieve_user_handler,
        session_backend_config=ServerSideSessionConfig(
            max_age=60 * 60 * 24 * 7,
            secure=settings.session_secure,
        ),
        exclude=AUTH_EXCLUDE_PATTERNS,
    )
