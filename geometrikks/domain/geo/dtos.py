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


@dataclass
class GeoJSONFeature:
    """GeoJSON Feature representing a location."""

    type: str = "Feature"
    geometry: GeoJSONPointGeometry = field(default_factory=GeoJSONPointGeometry)
    properties: GeoJSONFeatureProperties | None = None


@dataclass
class GeoJSONFeatureCollection:
    """GeoJSON FeatureCollection for locations with event counts."""

    type: str = "FeatureCollection"
    features: list[GeoJSONFeature] = field(default_factory=list)
    event_count: int = 0  # Total event count across all features
