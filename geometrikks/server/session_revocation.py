"""End every session at startup when the settings that decide who may log in change.

Sessions outlive restarts, so without this a new APP_ADMIN_PASSWORD or a
name removed from OIDC_ALLOWED_USERS would leave the old logins working.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import TYPE_CHECKING

from geometrikks.server.auth import _hasher
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from litestar.stores.base import Store

    from geometrikks.config.settings import Settings

logger = get_logger(__name__)

FINGERPRINT_KEY = "auth-settings"
_FINGERPRINT_LIFETIME = timedelta(days=36500)


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


async def revoke_sessions_if_auth_changed(
    sessions: Store, fingerprints: Store, settings: Settings
) -> bool:
    """Delete every session unless the stored fingerprint matches; True when it did."""
    material = auth_fingerprint_material(settings)
    stored = await fingerprints.get(FINGERPRINT_KEY)
    if stored is not None and _hasher.verify(material, stored.decode()):
        return False
    await sessions.delete_all()
    await fingerprints.set(
        FINGERPRINT_KEY, _hasher.hash(material), expires_in=_FINGERPRINT_LIFETIME
    )
    logger.info("sessions_revoked", reason="auth_settings_changed")
    return True
