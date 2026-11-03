"""Read-only, whitelisted application settings for the frontend.

Deliberately NOT settings.model_dump(): the full Settings tree contains
database credentials and the admin password. Only fields listed here are
exposed; add new fields consciously.
"""

from __future__ import annotations

from typing import Annotated

import msgspec

from litestar import Request, get
from litestar.di import NamedDependency
from litestar.params import SkipValidation

from geometrikks.config.settings import Settings
from geometrikks.server import runtime
from geometrikks.services.geoip.self_location import SelfLocation, SelfLocationSource


class LogparserSettingsView(msgspec.Struct, rename="camel"):
    """The log ingestion settings."""

    log_paths: Annotated[list[str], msgspec.Meta(description="The access log files this server tails, from LOGPARSER_LOG_PATHS.")]
    send_logs: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "Whether ingestion parses each line in full and stores an access log row with its HTTP fields. "
                "When false, GeoMetrikks still stores geo events but no access log rows."
            )
        ),
    ]
    store_debug_lines: Annotated[
        bool,
        msgspec.Meta(description="Whether every raw line goes to the debug table. When false, only malformed ones do."),
    ]


class AnalyticsSettingsView(msgspec.Struct, rename="camel"):
    """How many days the database keeps each kind of data, and when it compresses it."""

    raw_retention_days: Annotated[int, msgspec.Meta(description="Days to keep raw geo events and access log lines.")]
    debug_retention_days: Annotated[int, msgspec.Meta(description="Days to keep the access log debug lines.")]
    hourly_retention_days: Annotated[
        int, msgspec.Meta(description="Days to keep the hourly aggregates. GeoMetrikks keeps the daily aggregates forever.")
    ]
    compression_after_days: Annotated[
        int, msgspec.Meta(description="The age in days at which TimescaleDB compresses stored data.")
    ]


class DefaultMapView(msgspec.Struct, rename="camel"):
    """Where the map opens, from MAP_DEFAULT_VIEW."""

    latitude: float
    longitude: float
    zoom: Annotated[float, msgspec.Meta(description="The zoom level, from 0 to 22.")]


class MapSettingsView(msgspec.Struct, rename="camel"):
    """The map setup."""

    server_latitude: Annotated[
        float | None, msgspec.Meta(description="Where this server sits, in decimal degrees. Null when unknown.")
    ]
    server_longitude: Annotated[
        float | None, msgspec.Meta(description="Where this server sits, in decimal degrees. Null when unknown.")
    ]
    server_location_source: Annotated[
        SelfLocationSource | None,
        msgspec.Meta(
            description=(
                "`configured` when MAP_SERVER_LATITUDE and MAP_SERVER_LONGITUDE set the location, `external_ip` "
                "when GeoMetrikks looked up its own public IP."
            )
        ),
    ]
    carto_api_key: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The CARTO basemap key from MAP_CARTO_API_KEY, or null. It is no secret, since the browser sends "
                "it with every map tile request."
            )
        ),
    ]
    default_view: Annotated[
        DefaultMapView | None,
        msgspec.Meta(description="Null means the map opens on the server locations, or on the whole world."),
    ]


class RuntimeSettingsView(msgspec.Struct, rename="camel"):
    """Where the app runs."""

    container: Annotated[bool, msgspec.Meta(description="Whether the app runs from the GeoMetrikks container image.")]
    image_tag: Annotated[str | None, msgspec.Meta(description="The container image tag. Null outside a container.")]


class SafeSettingsResponse(msgspec.Struct, rename="camel"):
    """The settings the web app reads to set itself up. No credentials appear here."""

    name: str
    version: str
    environment: Annotated[
        str, msgspec.Meta(description="APP_ENVIRONMENT, one of `development`, `staging` or `production`.")
    ]
    runtime: RuntimeSettingsView
    logparser: LogparserSettingsView
    analytics: AnalyticsSettingsView
    map: MapSettingsView


@get(
    "/settings",
    tags=["Settings"],
    summary="Get the settings the web app needs",
    description=(
        "Returns the app name and version, the retention days, the access log paths and the map setup. "
        "Use `/api/v1/system/settings` for every setting with its environment variable."
    ),
)
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
