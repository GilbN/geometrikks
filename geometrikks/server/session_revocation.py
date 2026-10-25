"""End every session at startup when the settings that decide who may log in change.

Sessions outlive restarts, so without this a new APP_ADMIN_PASSWORD or a
name removed from OIDC_ALLOWED_USERS would leave the old logins working.
"""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from typing import TYPE_CHECKING, TypeVar

from pwdlib.exceptions import UnknownHashError

from geometrikks.server.auth import _hasher
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from litestar.stores.base import Store

    from geometrikks.config.settings import Settings

logger = get_logger(__name__)

FINGERPRINT_KEY = "auth-settings"
_FINGERPRINT_LIFETIME = timedelta(days=36500)

_T = TypeVar("_T")


class SessionRevocationError(RuntimeError):
    """A store call failed; carries only the step and the error type."""


def auth_fingerprint_material(settings: Settings) -> str:
    """Canonical JSON of every setting that narrows who gets in. Holds the admin password."""
    oidc = settings.oidc
    password = settings.admin_password.get_secret_value() if settings.admin_password else None
    return json.dumps(
        {
            "admin_user": settings.admin_user,
            "admin_password": password,
            "password_login_enabled": settings.password_login_enabled,
            "oidc_issuer": oidc.issuer,
            "oidc_client_id": oidc.client_id,
            "oidc_allowed_users": sorted(oidc.allowed_users),
            "oidc_allowed_groups": sorted(oidc.allowed_groups),
            "oidc_groups_claim": oidc.groups_claim,
            "oidc_scopes": sorted(oidc.scope_list),
        },
        sort_keys=True,
    )


async def _store_step(step: str, operation: Callable[[], Awaitable[_T]]) -> _T:
    failure = ""
    try:
        return await operation()
    except Exception as error:
        failure = type(error).__name__
    # Raised outside the except block so neither __cause__ nor __context__
    # holds the original: a DBAPIError's message lists the bound parameters,
    # which include the fingerprint hash.
    raise SessionRevocationError(f"Session revocation could not {step} ({failure})")


def _matches(material: str, stored: bytes) -> bool:
    try:
        return _hasher.verify(material, stored)
    except UnknownHashError:
        return False


async def revoke_sessions_if_auth_changed(
    sessions: Store, fingerprints: Store, settings: Settings
) -> bool:
    """Delete every session unless the stored fingerprint matches; True when it did."""
    material = auth_fingerprint_material(settings)
    stored = await _store_step(
        "read the auth fingerprint", lambda: fingerprints.get(FINGERPRINT_KEY)
    )
    if stored is not None and await asyncio.to_thread(_matches, material, stored):
        return False
    await _store_step("delete the sessions", sessions.delete_all)
    fingerprint = await asyncio.to_thread(_hasher.hash, material)
    await _store_step(
        "store the auth fingerprint",
        lambda: fingerprints.set(FINGERPRINT_KEY, fingerprint, expires_in=_FINGERPRINT_LIFETIME),
    )
    logger.info("sessions_revoked", reason="auth_settings_changed")
    return True
