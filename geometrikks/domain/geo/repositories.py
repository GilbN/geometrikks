"""Repositories for geo-location and geo-event data access."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Sequence

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.filters import LimitOffset, OrderBy, CollectionFilter
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

from litestar.pagination import OffsetPagination

from geometrikks.domain.geo.models import GeoLocation, GeoEvent

class GeoLocationRepository(SQLAlchemyAsyncRepository[GeoLocation]):
    """Repository for GeoLocation model."""

    model_type = GeoLocation
    
    async def get_by_country_code(self, ip_address: str) -> GeoLocation | None:
        """Retrieve a GeoLocation by its IP address."""
        query = select(self.model_type).where(self.model_type.country_code == ip_address)
        result = await self.session.execute(query)
        return result.scalars().one_or_none()

class GeoEventRepository(SQLAlchemyAsyncRepository[GeoEvent]):
    """Repository for GeoEvent model."""

    model_type = GeoEvent
    
    