"""DTOs for geo-location and geo-event data transfer."""

from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime

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


@dataclass
class EmbeddedLocationDTO:
    """Lightweight location data for embedding in other DTOs."""

    id: int
    latitude: float
    longitude: float
    city: str | None = None
    country_code: str | None = None
    country_name: str | None = None


@dataclass
class TopIPDTO:
    """Top IP address with event count and optional location."""

    ip_address: str
    event_count: int
    location: EmbeddedLocationDTO | None = None  # Optional - used for global top IPs


@dataclass
class GeoJSONPointGeometry:
    """GeoJSON Point geometry."""

    type: str = "Point"
    coordinates: tuple[float, float] = field(default_factory=lambda: (0.0, 0.0))


@dataclass
class GeoJSONFeatureProperties:
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
    top_ips: list[TopIPDTO] = field(default_factory=list)


@dataclass
class GeoJSONFeature:
    """GeoJSON Feature representing a location."""

    type: str = "Feature"
    geometry: GeoJSONPointGeometry = field(default_factory=GeoJSONPointGeometry)
    properties: GeoJSONFeatureProperties | None = None

@dataclass
class GeoJSONFeatureStats:
    """Statistics for GeoJSONFeatureCollection."""

    events: int = 0
    countries: int = 0
    cities: int = 0
    locations: int = 0

@dataclass
class GeoJSONFeatureCollection:
    """GeoJSON FeatureCollection for locations with event counts."""

    type: str = "FeatureCollection"
    features: list[GeoJSONFeature] = field(default_factory=list)
    stats: GeoJSONFeatureStats = field(default_factory=GeoJSONFeatureStats)


@dataclass
class LocationTopIPsResponse:
    """Response for location top IPs endpoint."""

    location_id: int
    top_ips: list[TopIPDTO] = field(default_factory=list)


@dataclass
class GlobalTopIPsResponse:
    """Response for global top IPs endpoint."""

    top_ips: list[TopIPDTO] = field(default_factory=list)

