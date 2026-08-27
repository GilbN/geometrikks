"""DTOs for geo-location and geo-event data transfer."""

from __future__ import annotations
from datetime import datetime
from typing import Literal

import msgspec

from advanced_alchemy.extensions.litestar import SQLAlchemyDTO, SQLAlchemyDTOConfig
from geometrikks.domain.geo.models import GeoEvent, GeoLocation


class GeoEventDTO(SQLAlchemyDTO[GeoEvent]):
    """Data transfer object for GeoEvent model."""

    config = SQLAlchemyDTOConfig(rename_strategy="camel")


class GeoLocationDTO(SQLAlchemyDTO[GeoLocation]):
    """Data transfer object for GeoLocation model."""

    config = SQLAlchemyDTOConfig(
        rename_strategy="camel",
        exclude={"geo_events"},
    )


class EmbeddedLocationDTO(msgspec.Struct, rename="camel"):
    """Lightweight location data for embedding in other DTOs."""

    id: int
    latitude: float
    longitude: float
    city: str | None = None
    country_code: str | None = None
    country_name: str | None = None


class TopIPDTO(msgspec.Struct, rename="camel"):
    """Top IP address with event count and optional location."""

    ip_address: str
    event_count: int
    location: EmbeddedLocationDTO | None = None  # Optional - used for global top IPs


class GeoJSONPointGeometry(msgspec.Struct, rename="camel"):
    """GeoJSON Point geometry.

    Fields are deliberately default-less: dataclass defaults make them
    non-required in OpenAPI, which turns into optional fields in the
    generated TS client. The controller always constructs them explicitly.
    """

    type: str
    coordinates: tuple[float, float]


class GeoJSONFeatureProperties(msgspec.Struct, rename="camel"):
    """Properties for a GeoJSON feature representing a location with event count."""

    id: int
    geohash: str
    country_code: str
    country_name: str
    last_hit: datetime | None
    state: str | None
    state_code: str | None
    city: str | None
    postal_code: str | None
    timezone: str | None
    event_count: int
    top_ips: list[TopIPDTO] = msgspec.field(default_factory=list)


class GeoJSONFeature(msgspec.Struct, rename="camel"):
    """GeoJSON Feature representing a location."""

    type: str
    geometry: GeoJSONPointGeometry
    properties: GeoJSONFeatureProperties

class GeoJSONFeatureStats(msgspec.Struct, rename="camel"):
    """Statistics for GeoJSONFeatureCollection."""

    events: int
    countries: int
    cities: int
    locations: int

class GeoJSONFeatureCollection(msgspec.Struct, rename="camel"):
    """GeoJSON FeatureCollection for locations with event counts."""

    type: str
    features: list[GeoJSONFeature]
    stats: GeoJSONFeatureStats


class LocationTopIPsResponse(msgspec.Struct, rename="camel"):
    """Response for location top IPs endpoint."""

    location_id: int
    top_ips: list[TopIPDTO] = msgspec.field(default_factory=list)


class GlobalTopIPsResponse(msgspec.Struct, rename="camel"):
    """Response for global top IPs endpoint."""

    top_ips: list[TopIPDTO] = msgspec.field(default_factory=list)


class TopCountryDTO(msgspec.Struct, rename="camel"):
    """Top country with event count."""

    country_code: str
    country_name: str | None
    event_count: int


class TopCountriesResponse(msgspec.Struct, rename="camel"):
    """Response for top countries endpoint."""

    top_countries: list[TopCountryDTO] = msgspec.field(default_factory=list)


class SiteHomeView(msgspec.Struct, rename="camel"):
    """One hostname's current home location, auto-detected or overridden."""

    hostname: str
    latitude: float
    longitude: float
    source: Literal["auto", "override"]
    detected_at: str | None
    # Day precision (from the daily hostname aggregate); None when the
    # hostname has never recorded a geo event.
    last_event_day: str | None


class DefaultHomeView(msgspec.Struct, rename="camel"):
    """Instance-wide fallback home used when a hostname has no site_homes row."""

    latitude: float
    longitude: float


class SiteHomesResponse(msgspec.Struct, rename="camel"):
    """Per-source home locations for the map, plus the instance default."""

    homes: list[SiteHomeView]
    default: DefaultHomeView | None

