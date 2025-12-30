"""Repositories for geo-location and geo-event data access."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, func, text
from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.geo.models import GeoLocation, GeoEvent


@dataclass
class TopIP:
    """Top IP with event count for a location."""

    ip_address: str
    event_count: int


@dataclass
class LocationWithEventCount:
    """GeoLocation with aggregated event count."""

    location: GeoLocation
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

    async def get_all_with_event_counts(
        self, from_timestamp: datetime, to_timestamp: datetime
    ) -> list[LocationWithEventCount]:
        """Retrieve all GeoLocations with their associated event counts.

        Uses a simple GROUP BY query for fast aggregation without per-location top IPs.

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.

        Returns:
            list[LocationWithEventCount]: List containing location and event count.

        Raises:
            ValueError: If from_timestamp or to_timestamp are not timezone-aware datetimes.
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")

        stmt = text("""
            SELECT
                gl.*,
                CAST(COUNT(ge.id) AS INTEGER) as event_count
            FROM geo_locations gl
            JOIN geo_events ge ON ge.location_id = gl.id
            WHERE ge.timestamp BETWEEN :from_ts AND :to_ts
            GROUP BY gl.id
            ORDER BY event_count DESC
        """)

        result = await self.session.execute(
            stmt, {"from_ts": from_timestamp, "to_ts": to_timestamp}
        )
        rows = result.fetchall()

        if not rows:
            return []

        return [
            LocationWithEventCount(
                location=GeoLocation(
                    id=row.id,
                    latitude=row.latitude,
                    longitude=row.longitude,
                    geohash=row.geohash,
                    geographic_point=row.geographic_point,
                    country_code=row.country_code,
                    country_name=row.country_name,
                    state=row.state,
                    state_code=row.state_code,
                    city=row.city,
                    postal_code=row.postal_code,
                    timezone=row.timezone,
                    last_hit=row.last_hit,
                    created_at=row.created_at,
                    updated_at=row.updated_at,
                ),
                event_count=row.event_count,
            )
            for row in rows
        ]

    async def get_location_top_ips(
        self, location_id: int, from_timestamp: datetime, to_timestamp: datetime, limit: int = 5
    ) -> list[TopIP]:
        """Get top N IPs for a specific location by event count.

        Args:
            location_id: The location ID to get top IPs for.
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
            limit: Maximum number of IPs to return.

        Returns:
            List of TopIP objects with ip_address and event_count.
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")

        stmt = text("""
            SELECT
                ip_address,
                CAST(COUNT(*) AS INTEGER) as event_count
            FROM geo_events
            WHERE location_id = :location_id
              AND timestamp BETWEEN :from_ts AND :to_ts
            GROUP BY ip_address
            ORDER BY event_count DESC
            LIMIT :limit
        """)

        result = await self.session.execute(
            stmt,
            {
                "location_id": location_id,
                "from_ts": from_timestamp,
                "to_ts": to_timestamp,
                "limit": limit,
            },
        )
        rows = result.fetchall()

        return [TopIP(ip_address=str(row.ip_address), event_count=row.event_count) for row in rows]

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
    
    