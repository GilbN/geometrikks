"""Connection information for scripts and dashboards."""

from datetime import datetime
from typing import Annotated, Literal

import msgspec

from geometrikks.config.settings import Settings
from geometrikks.domain.auth.api_keys import ApiKeyScope
from geometrikks.server.api_key_auth import ApiKeyPrincipal
from geometrikks.server.api_version import API_VERSION
from geometrikks.server.auth import AdminUser

Capability = Literal["crowdsec", "crowdsecWrite", "asn", "drop"]


class ConnectionInfo(msgspec.Struct, kw_only=True, rename="camel"):
    """The server version and configured features, without checking upstream availability."""

    app_version: str
    api_version: str
    capabilities: Annotated[
        list[Capability],
        msgspec.Meta(description=(
            "Configured server features, independent of key scope and current service availability. "
            "crowdsecWrite also requires a read_write key or a browser session when auth is enabled."
        )),
    ]


class ApiKeyConnection(ConnectionInfo, tag_field="mode", tag="apiKey", kw_only=True):
    """A successfully authenticated API key. An expired key gets a 401 instead."""

    name: str
    scope: ApiKeyScope
    expires_at: Annotated[datetime | None, msgspec.Meta(description="The key's expiry, or null if it never expires.")]


class SessionConnection(ConnectionInfo, tag_field="mode", tag="session", kw_only=True):
    """The request used an authenticated browser session."""


class DisabledConnection(ConnectionInfo, tag_field="mode", tag="disabled", kw_only=True):
    """Authentication is disabled, so this response does not validate a supplied key."""


ConnectionResponse = ApiKeyConnection | SessionConnection | DisabledConnection


def connection_info(settings: Settings, user: AdminUser | ApiKeyPrincipal | None) -> ConnectionResponse:
    """Build connection metadata from settings and the already authenticated principal."""
    capabilities: list[Capability] = []
    if settings.crowdsec.enabled:
        capabilities.append("crowdsec")
    if settings.crowdsec.write_enabled:
        capabilities.append("crowdsecWrite")
    if settings.geoip.asn_enabled:
        capabilities.append("asn")
    if settings.drop.enabled:
        capabilities.append("drop")
    version = settings.version
    if settings.auth_disabled:
        return DisabledConnection(app_version=version, api_version=API_VERSION, capabilities=capabilities)
    if isinstance(user, ApiKeyPrincipal):
        return ApiKeyConnection(
            app_version=version, api_version=API_VERSION, capabilities=capabilities,
            name=user.name, scope=user.scope, expires_at=user.expires_at,
        )
    return SessionConnection(app_version=version, api_version=API_VERSION, capabilities=capabilities)
