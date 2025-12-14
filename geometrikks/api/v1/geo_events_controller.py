"""GeoEvent API endpoints."""
from __future__ import annotations

from litestar import Controller, get
from litestar.di import Provide
from litestar.pagination import OffsetPagination
from litestar.status_codes import HTTP_201_CREATED, HTTP_204_NO_CONTENT
from litestar.plugins.sqlalchemy import filters
from geometrikks.domain.geo.models import GeoEvent
from geometrikks.domain.geo.repositories import GeoEventRepository
from geometrikks.domain.geo.dtos import (
    GeoEventDTO
)
from geometrikks.api.dependencies import provide_geo_event_repo


class GeoEventController(Controller):
    """
    Geo-event tracking endpoints.

    Handles CRUD operations for IP geo-location events.
    """

    path = "/api/v1/geo-events"
    return_dto = GeoEventDTO 
    tags = ["Geo Events"]

    dependencies = {
        "geo_event_repo": Provide(provide_geo_event_repo),
    }
    
    @get("/")
    async def list_geo_events(
        self,
        geo_event_repo: GeoEventRepository,
        limit_offset: filters.LimitOffset,
    ) -> OffsetPagination[GeoEvent]:
        """List all geo-events with pagination."""
        results, total = await geo_event_repo.list_and_count(limit_offset)
        return OffsetPagination[GeoEvent](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset
        )
