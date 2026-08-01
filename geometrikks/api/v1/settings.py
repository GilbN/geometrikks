"""Read-only, whitelisted application settings for the frontend.

Deliberately NOT settings.model_dump(): the full Settings tree contains
database credentials and the admin password. Only fields listed here are
exposed; add new fields consciously.
"""

from __future__ import annotations

from dataclasses import dataclass

from litestar import Request, get
from litestar.di import NamedDependency
from litestar.params import SkipValidation

from geometrikks.config.settings import Settings
from geometrikks.services.geoip.home import HomeLocation, HomeLocationSource


@dataclass
class LogparserSettingsView:
    log_paths: list[str]
    send_logs: bool
    store_debug_lines: bool


@dataclass
class AnalyticsSettingsView:
    raw_retention_days: int
    debug_retention_days: int
    hourly_retention_days: int
    compression_after_days: int


@dataclass
class MapSettingsView:
    home_latitude: float | None
    home_longitude: float | None
    home_source: HomeLocationSource | None


@dataclass
class RuntimeSettingsView:
    """Non-sensitive information about the executing application image."""

    container: bool
    image_tag: str | None


@dataclass
class SafeSettingsResponse:
    name: str
    version: str
    environment: str
    runtime: RuntimeSettingsView
    logparser: LogparserSettingsView
    analytics: AnalyticsSettingsView
    map: MapSettingsView


@get("/api/v1/settings", tags=["Settings"])
async def read_settings(
    request: Request, settings: NamedDependency[SkipValidation[Settings]]
) -> SafeSettingsResponse:
    """Whitelisted runtime settings (no credentials, ever)."""
    s = settings
    home: HomeLocation | None = getattr(request.app.state, "map_home_location", None)
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
        ),
    )
