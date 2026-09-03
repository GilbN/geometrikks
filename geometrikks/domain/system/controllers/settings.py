"""Read-only, whitelisted application settings for the frontend.

Deliberately NOT settings.model_dump(): the full Settings tree contains
database credentials and the admin password. Only fields listed here are
exposed; add new fields consciously.
"""

from __future__ import annotations

import msgspec

from litestar import Request, get
from litestar.di import NamedDependency
from litestar.params import SkipValidation

from geometrikks.config.settings import Settings
from geometrikks.server import runtime
from geometrikks.services.geoip.home import HomeLocation, HomeLocationSource


class LogparserSettingsView(msgspec.Struct, rename="camel"):
    log_paths: list[str]
    send_logs: bool
    store_debug_lines: bool


class AnalyticsSettingsView(msgspec.Struct, rename="camel"):
    raw_retention_days: int
    debug_retention_days: int
    hourly_retention_days: int
    compression_after_days: int


class MapSettingsView(msgspec.Struct, rename="camel"):
    home_latitude: float | None
    home_longitude: float | None
    home_source: HomeLocationSource | None
    carto_api_key: str | None


class RuntimeSettingsView(msgspec.Struct, rename="camel"):
    """Non-sensitive information about the executing application image."""

    container: bool
    image_tag: str | None


class SafeSettingsResponse(msgspec.Struct, rename="camel"):
    name: str
    version: str
    environment: str
    runtime: RuntimeSettingsView
    logparser: LogparserSettingsView
    analytics: AnalyticsSettingsView
    map: MapSettingsView


@get("/settings", tags=["Settings"])
async def read_settings(
    request: Request, settings: NamedDependency[SkipValidation[Settings]]
) -> SafeSettingsResponse:
    """Whitelisted runtime settings (no credentials, ever)."""
    s = settings
    home: HomeLocation | None = runtime.get_map_home_location(request.app)
    if home is None and s.map.home_latitude is not None and s.map.home_longitude is not None:
        home = HomeLocation(
            latitude=s.map.home_latitude,
            longitude=s.map.home_longitude,
            source="configured",
        )
    return SafeSettingsResponse(
        name=s.name,
        version=s.version,
        environment=s.environment,
        runtime=RuntimeSettingsView(
            container=s.runtime == "container",
            image_tag=s.image_tag if s.runtime == "container" else None,
        ),
        logparser=LogparserSettingsView(
            log_paths=[str(p) for p in s.logparser.log_paths],
            send_logs=s.logparser.send_logs,
            store_debug_lines=s.logparser.store_debug_lines,
        ),
        analytics=AnalyticsSettingsView(
            raw_retention_days=s.analytics.raw_retention_days,
            debug_retention_days=s.analytics.debug_retention_days,
            hourly_retention_days=s.analytics.hourly_retention_days,
            compression_after_days=s.analytics.compression_after_days,
        ),
        map=MapSettingsView(
            home_latitude=home.latitude if home else None,
            home_longitude=home.longitude if home else None,
            home_source=home.source if home else None,
            carto_api_key=s.map.carto_api_key or None,
        ),
    )
