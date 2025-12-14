"""GeoLocation API endpoints."""
from __future__ import annotations

from litestar.plugins.sqlalchemy import filters
from litestar.pagination import OffsetPagination
from litestar import Controller, get
from litestar.di import Provide
from litestar.status_codes import HTTP_201_CREATED

from geometrikks.domain.geo.models import GeoLocation
from geometrikks.domain.geo.repositories import GeoLocationRepository
from geometrikks.domain.geo.dtos import GeoLocationDTO

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
            offset=limit_offset.offset
        )