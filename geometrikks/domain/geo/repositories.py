"""Repositories for geo-location and geo-event data access."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select, func
from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.geo.models import GeoLocation, GeoEvent


@dataclass
class TopIP:
    """Top IP with event count for a location."""
    
    ip_address: str
    event_count: int


@dataclass
class LocationWithEventCount:
    """GeoLocation with aggregated event count and top IPs."""

    location: GeoLocation
    event_count: int
    top_ips: list[TopIP] = field(default_factory=list)


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

    async def get_all_with_event_counts(
        self, from_timestamp: datetime, to_timestamp: datetime
    ) -> list[LocationWithEventCount]:
        """Retrieve all GeoLocations with their associated event counts and top 5 IPs.

        Performs two queries:
        1. Get locations with total event counts
        2. Get top 5 IPs per location using window function

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.

        Returns:
            list[LocationWithEventCount]: List containing location, event count, and top 5 IPs.

        Raises:
            ValueError: If from_timestamp or to_timestamp are not timezone-aware datetimes.
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")

        # Query 1: Get locations with total event counts
        locations_stmt = (
            select(GeoLocation, func.count(GeoEvent.id).label("event_count"))
            .join(GeoEvent, GeoLocation.id == GeoEvent.location_id)
            .where(GeoEvent.timestamp.between(from_timestamp, to_timestamp))
            .group_by(GeoLocation.id)
            .order_by(func.count(GeoEvent.id).desc())
        )
        locations_result = await self.session.execute(locations_stmt)
        locations_data = locations_result.all()

        if not locations_data:
            return []

        location_ids = [row[0].id for row in locations_data]

        # Query 2: Get top 5 IPs per location using window function
        top_ips_subq = (
            select(
                GeoEvent.location_id,
                GeoEvent.ip_address,
                func.count().label("ip_count"),
                func.row_number()
                .over(partition_by=GeoEvent.location_id, order_by=func.count().desc())
                .label("rn"),
            )
            .where(
                GeoEvent.timestamp.between(from_timestamp, to_timestamp),
                GeoEvent.location_id.in_(location_ids),
            )
            .group_by(GeoEvent.location_id, GeoEvent.ip_address)
        ).subquery()

        top_ips_stmt = (
            select(
                top_ips_subq.c.location_id,
                top_ips_subq.c.ip_address,
                top_ips_subq.c.ip_count,
            )
            .where(top_ips_subq.c.rn <= 5)
            .order_by(top_ips_subq.c.location_id, top_ips_subq.c.ip_count.desc())
        )
        top_ips_result = await self.session.execute(top_ips_stmt)

        # Build lookup dict: location_id -> list[TopIP]
        top_ips_by_location: dict[int, list[TopIP]] = {}
        for row in top_ips_result.all():
            loc_id, ip_addr, ip_count = row
            if loc_id not in top_ips_by_location:
                top_ips_by_location[loc_id] = []
            top_ips_by_location[loc_id].append(TopIP(ip_address=ip_addr, event_count=ip_count))

        return [
            LocationWithEventCount(
                location=row[0],
                event_count=row[1],
                top_ips=top_ips_by_location.get(row[0].id, []),
            )
            for row in locations_data
        ]

    async def get_global_top_ips(
        self, from_timestamp: datetime, to_timestamp: datetime, limit: int = 5
    ) -> list[tuple[str, int, GeoLocation]]:
        """Get global top N IPs by event count with their primary location.

        For IPs that appear in multiple locations, returns the location
        where they have the highest event count.

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
            limit: Maximum number of IPs to return.

        Returns:
            List of tuples containing (ip_address, event_count, GeoLocation).
        """
        # Get top IPs with their most common location
        stmt = (
            select(
                GeoEvent.ip_address,
                func.count().label("event_count"),
                GeoEvent.location_id,
            )
            .where(GeoEvent.timestamp.between(from_timestamp, to_timestamp))
            .group_by(GeoEvent.ip_address, GeoEvent.location_id)
            .order_by(func.count().desc())
            .limit(limit * 2)  # Get extra to dedupe IPs
        )
        result = await self.session.execute(stmt)

        # Dedupe by IP, keeping highest count location
        seen_ips: set[str] = set()
        top_ips: list[tuple[str, int, GeoLocation]] = []
        for ip, count, loc_id in result.all():
            if ip not in seen_ips and len(top_ips) < limit:
                seen_ips.add(ip)
                location = await self.session.get(GeoLocation, loc_id)
                if location:
                    top_ips.append((ip, count, location))

        return top_ips


class GeoEventRepository(SQLAlchemyAsyncRepository[GeoEvent]):
    """Repository for GeoEvent model."""

    model_type = GeoEvent
    
    