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
    """GeoJSON Point geometry.

    Fields are deliberately default-less: dataclass defaults make them
    non-required in OpenAPI, which turns into optional fields in the
    generated TS client. The controller always constructs them explicitly.
    """

    type: str
    coordinates: tuple[float, float]


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

    type: str
    geometry: GeoJSONPointGeometry
    properties: GeoJSONFeatureProperties

@dataclass
class GeoJSONFeatureStats:
    """Statistics for GeoJSONFeatureCollection."""

    events: int
    countries: int
    cities: int
    locations: int

@dataclass
class GeoJSONFeatureCollection:
    """GeoJSON FeatureCollection for locations with event counts."""

    type: str
    features: list[GeoJSONFeature]
    stats: GeoJSONFeatureStats


@dataclass
class LocationTopIPsResponse:
    """Response for location top IPs endpoint."""

    location_id: int
    top_ips: list[TopIPDTO] = field(default_factory=list)


@dataclass
class GlobalTopIPsResponse:
    """Response for global top IPs endpoint."""

    top_ips: list[TopIPDTO] = field(default_factory=list)


@dataclass
class TopCountryDTO:
    """Top country with event count."""

    country_code: str
    country_name: str | None
    event_count: int


@dataclass
class TopCountriesResponse:
    """Response for top countries endpoint."""

    top_countries: list[TopCountryDTO] = field(default_factory=list)

