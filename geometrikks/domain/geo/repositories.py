"""Repositories for geo-location and geo-event data access."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, func
from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.geo.models import GeoLocation, GeoEvent


@dataclass
class LocationWithEventCount:
    """GeoLocation with aggregated event count."""

    location: GeoLocation
    ip_address: str | None
    hostname: str | None
    event_count: int


class GeoLocationRepository(SQLAlchemyAsyncRepository[GeoLocation]):
    """Repository for GeoLocation model."""

    model_type = GeoLocation

    async def get_by_geohash(self, geohash: str) -> GeoLocation | None:
        """Find a GeoLocation by its geohash.

        Args:
            geohash: The geohash string to search for.

        Returns:
            GeoLocation if found, None otherwise.
        """
        return await self.get_one_or_none(geohash=geohash)

    async def get_by_country_code(self, country_code: str) -> list[GeoLocation]:
        """Retrieve all GeoLocations for a given country code.

        Args:
            country_code: ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE').

        Returns:
            List of GeoLocation instances matching the country code.
        """
        return await self.list(country_code=country_code)

    async def get_all_with_event_counts(self, from_timestamp: datetime, to_timestamp: datetime) -> list[LocationWithEventCount]:
        """Retrieve all GeoLocations with their associated event counts.

        Performs a LEFT JOIN with GeoEvent to count events per location.

        Returns:
            list[LocationWithEventCount]: List of LocationWithEventCount containing location and event count.
            
        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
        
        Raises:
            ValueError: If from_timestamp or to_timestamp are not timezone-aware datetimes.
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")
        stmt = (
            select(GeoLocation, GeoEvent.ip_address, GeoEvent.hostname, func.count(GeoEvent.id).label("event_count"))
            .outerjoin(GeoEvent, GeoLocation.id == GeoEvent.location_id)
            .group_by(GeoLocation.id, GeoEvent.ip_address, GeoEvent.hostname)
            .order_by(func.count(GeoEvent.id).desc())
            .where(GeoEvent.timestamp.between(from_timestamp, to_timestamp))
        )
        result = await self.session.execute(stmt)
        return [
            LocationWithEventCount(location=row[0], ip_address=row[1], hostname=row[2], event_count=row[3])
            for row in result.all()
        ]


class GeoEventRepository(SQLAlchemyAsyncRepository[GeoEvent]):
    """Repository for GeoEvent model."""

    model_type = GeoEvent
    
    