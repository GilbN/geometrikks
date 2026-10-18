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
from geometrikks.services.geoip.self_location import SelfLocation, SelfLocationSource


class LogparserSettingsView(msgspec.Struct, rename="camel"):
    log_paths: list[str]
    send_logs: bool
    store_debug_lines: bool


class AnalyticsSettingsView(msgspec.Struct, rename="camel"):
    raw_retention_days: int
    debug_retention_days: int
    hourly_retention_days: int
    compression_after_days: int


class DefaultMapView(msgspec.Struct, rename="camel"):
    latitude: float
    longitude: float
    zoom: float


class MapSettingsView(msgspec.Struct, rename="camel"):
    server_latitude: float | None
    server_longitude: float | None
    server_location_source: SelfLocationSource | None
    carto_api_key: str | None
    default_view: DefaultMapView | None


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
    self_location: SelfLocation | None = runtime.get_self_location(request.app)
    if self_location is None and s.map.server_latitude is not None and s.map.server_longitude is not None:
        self_location = SelfLocation(
            latitude=s.map.server_latitude,
            longitude=s.map.server_longitude,
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
            server_latitude=self_location.latitude if self_location else None,
            server_longitude=self_location.longitude if self_location else None,
            server_location_source=self_location.source if self_location else None,
            carto_api_key=s.map.carto_api_key or None,
            default_view=(
                DefaultMapView(
                    latitude=s.map.default_view[0],
                    longitude=s.map.default_view[1],
                    zoom=s.map.default_view[2],
                )
                if s.map.default_view
                else None
            ),
        ),
    )
