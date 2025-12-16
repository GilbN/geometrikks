"""GeoLocation API endpoints."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Annotated

from litestar.plugins.sqlalchemy import filters
from litestar.pagination import OffsetPagination
from litestar import Controller, get
from litestar.di import Provide
from litestar.params import Parameter
from litestar.openapi.spec import Example

from geometrikks.domain.geo.models import GeoLocation
from geometrikks.domain.geo.repositories import GeoLocationRepository
from geometrikks.domain.geo.dtos import (
    GeoLocationDTO,
    GeoJSONFeatureCollection,
    GeoJSONFeature,
    GeoJSONPointGeometry,
    GeoJSONFeatureProperties,
)

from geometrikks.api.dependencies import provide_geo_location_repo


class GeoLocationController(Controller):
    """Geo-location endpoints for managing location data."""

    path = "/api/v1/geo-locations"
    tags = ["Geo Locations"]
    return_dto = GeoLocationDTO

    dependencies = {
        "geo_location_repo": Provide(provide_geo_location_repo),
    }

    @get("/")
    async def list_geo_locations(
        self,
        geo_location_repo: GeoLocationRepository,
        limit_offset: filters.LimitOffset,
    ) -> OffsetPagination[GeoLocation]:
        """List all geo-locations with pagination."""
        results, total = await geo_location_repo.list_and_count(limit_offset)
        return OffsetPagination[GeoLocation](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset,
        )

    @get("/geojson", return_dto=None, description="Get all locations with event counts as GeoJSON FeatureCollection.")
    async def get_geojson(
        self,
        geo_location_repo: GeoLocationRepository,
        from_timestamp: Annotated[
            datetime,
            Parameter(
                description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value=str(datetime.now(timezone.utc)))],
            ),
        ],
        to_timestamp: Annotated[
            datetime,
            Parameter(
                description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value=str(datetime.now(timezone.utc)))],
            ),
        ],
    ) -> GeoJSONFeatureCollection:
        """Get all locations with event counts as GeoJSON FeatureCollection.

        Returns a GeoJSON FeatureCollection where each feature represents a
        location with its coordinates and properties including the event count.
        Args:
            from_datetime: Start datetime for filtering events.
            to_datetime: End datetime for filtering events.
        Returns:
            GeoJSONFeatureCollection containing locations and their event counts.
        """
        # Ensure timezone awareness if datetimes are provided
        if from_timestamp is not None and from_timestamp.tzinfo is None:
            from_timestamp = from_timestamp.replace(tzinfo=timezone.utc)
        if to_timestamp is not None and to_timestamp.tzinfo is None:
            to_timestamp = to_timestamp.replace(tzinfo=timezone.utc)

        locations_with_counts = await geo_location_repo.get_all_with_event_counts(
            from_timestamp, to_timestamp
        )

        features = [
            GeoJSONFeature(
                type="Feature",
                geometry=GeoJSONPointGeometry(
                    type="Point",
                    coordinates=(loc.location.longitude, loc.location.latitude),
                ),
                properties=GeoJSONFeatureProperties(
                    id=loc.location.id,
                    geohash=loc.location.geohash,
                    country_code=loc.location.country_code,
                    country_name=loc.location.country_name,
                    state=loc.location.state,
                    state_code=loc.location.state_code,
                    city=loc.location.city,
                    postal_code=loc.location.postal_code,
                    timezone=loc.location.timezone,
                    event_count=loc.event_count,
                ),
            )
            for loc in locations_with_counts
        ]

        return GeoJSONFeatureCollection(type="FeatureCollection", features=features)
