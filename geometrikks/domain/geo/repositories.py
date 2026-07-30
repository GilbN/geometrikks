"""Repositories for geo-location and geo-event data access.

CAGG Routing:
- RAW (geo_events): For time ranges <= 24 hours (exact granularity needed)
- location_hourly_stats: For time ranges > 24 hours and <= 30 days
- location_daily_stats: For time ranges > 30 days
- ip_location_{hourly,daily}_stats: For top IPs queries, stitched with raw edges
  for exact partial-bucket coverage.

Note: We use hourly CAGGs for up to 30 days because they properly support
real-time aggregation. Daily CAGGs have watermark limitations that can cause
staleness for the current day. For sub-hour ranges, we query raw tables
to get exact time range results.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum

from sqlalchemy import text
from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class StatsGranularity(Enum):
    """Granularity for query routing."""

    RAW = "raw"  # geo_events table (≤ 24 hours) - exact granularity
    HOURLY = "hourly"  # location_hourly_stats (> 24 hours, ≤ 30 days)
    DAILY = "daily"  # location_daily_stats (> 30 days)


def get_stats_granularity(from_timestamp: datetime, to_timestamp: datetime) -> StatsGranularity:
    """Determine the optimal query source based on time range duration.

    Routing logic:
    - ≤ 24 hours: RAW (query geo_events for exact granularity)
    - > 24 hours, ≤ 30 days: HOURLY CAGG (real-time aggregation provides fresh data)
    - > 30 days: DAILY CAGG (some staleness acceptable for long ranges)

    Note: We use hourly CAGG for up to 30 days because daily CAGGs can't
    do real-time aggregation for the current day (watermark is at next day).

    Args:
        from_timestamp: Start of time range.
        to_timestamp: End of time range.

    Returns:
        StatsGranularity indicating which source to query.
    """
    duration = to_timestamp - from_timestamp

    if duration <= timedelta(hours=24):
        return StatsGranularity.RAW
    elif duration <= timedelta(days=30):
        return StatsGranularity.HOURLY
    else:
        return StatsGranularity.DAILY


IP_LOCATION_CAGGS = {
    StatsGranularity.HOURLY: ("ip_location_hourly_stats", "1 hour"),
    StatsGranularity.DAILY: ("ip_location_daily_stats", "1 day"),
}


def stitch_params(
    start: datetime, end: datetime, granularity: StatsGranularity
) -> dict:
    """Bind params for a stitched CAGG read: window edges + inward bucket snap.

    a_start/a_end snap the [start, end) window inward to whole buckets (UTC
    aligned, matching time_bucket). Clamped so a window spanning no complete
    bucket degenerates to a pure raw scan (empty CAGG leg, one head slice
    covering the whole window).

    Computed in Python and bound as plain parameters deliberately: routing
    the bounds through a SQL CTE joined into each leg turns the timestamp
    constraints into join predicates, which TimescaleDB cannot use for chunk
    exclusion - the raw legs then decompress and scan the entire hypertable.
    """
    if granularity == StatsGranularity.DAILY:
        floor_start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        floor_end = end.replace(hour=0, minute=0, second=0, microsecond=0)
        step = timedelta(days=1)
    else:
        floor_start = start.replace(minute=0, second=0, microsecond=0)
        floor_end = end.replace(minute=0, second=0, microsecond=0)
        step = timedelta(hours=1)
    a_start = start if floor_start == start else floor_start + step
    a_start = min(a_start, end)
    a_end = max(floor_end, a_start)
    return {"start": start, "end": end, "a_start": a_start, "a_end": a_end}


def stitched_ip_location_cte(granularity: StatsGranularity) -> str:
    """WITH clause exposing ``combined`` for a per-IP CAGG read.

    Reading a CAGG requires whole buckets, so a window that starts mid-bucket
    used to be floored outward - silently pulling in a partial extra bucket and
    over-counting against the equivalent raw scan. The window is snapped
    *inward* to whole buckets (``stitch_params``; callers bind its params) and
    the leftover head/tail slices are read straight from ``geo_events``, so
    the union is exact.

    ``combined`` yields (location_id, ip_address, event_count, last_seen); it is
    keyed by IP on all legs, so ``COUNT(DISTINCT ip_address)`` over it stays
    exact rather than summing per-bucket counts. ``last_seen`` is bucket-granular
    for CAGG rows and exact for the raw edge rows.
    """
    table, _ = IP_LOCATION_CAGGS[granularity]
    return f"""
        WITH combined AS (
            SELECT s.location_id, s.ip_address, s.event_count, s.bucket AS last_seen
            FROM {table} s
            WHERE s.bucket >= :a_start AND s.bucket < :a_end
            UNION ALL
            SELECT ge.location_id, ge.ip_address, CAST(1 AS BIGINT), ge.timestamp
            FROM geo_events ge
            WHERE ge.timestamp >= :start AND ge.timestamp < :a_start
            UNION ALL
            SELECT ge.location_id, ge.ip_address, CAST(1 AS BIGINT), ge.timestamp
            FROM geo_events ge
            WHERE ge.timestamp >= :a_end AND ge.timestamp < :end
        )
    """


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
        self,
        from_timestamp: datetime,
        to_timestamp: datetime,
        country_codes: list[str] | None = None,
        cities: list[str] | None = None,
        ip_addresses: list[str] | None = None,
        ip_addresses_exclude: list[str] | None = None,
        hostnames: list[str] | None = None,
    ) -> list[LocationWithEventCount]:
        """Retrieve all GeoLocations with their associated event counts.

        Routes to optimal source based on time range:
        - ≤ 24 hours: RAW geo_events table (exact granularity)
        - > 24 hours, ≤ 30 days: location_hourly_stats CAGG
        - > 30 days: location_daily_stats CAGG

        Any IP/hostname filter forces the RAW branch regardless of range:
        the location CAGGs carry no IP or hostname dimension. Such queries
        are bounded by raw retention (default 180d).

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
            country_codes: Optional ISO country codes to filter to.
            cities: Optional city names to filter to.
            ip_addresses: Optional IPs to include (caller must validate).
            ip_addresses_exclude: Optional IPs to exclude (caller must validate).
            hostnames: Optional recording hostnames to filter to.

        Returns:
            list[LocationWithEventCount]: List containing location and event count.

        Raises:
            ValueError: If from_timestamp or to_timestamp are not timezone-aware datetimes.
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")

        granularity = get_stats_granularity(from_timestamp, to_timestamp)
        if ip_addresses or ip_addresses_exclude or hostnames:
            granularity = StatsGranularity.RAW

        logger.debug(
            "get_all_with_event_counts: using %s for range %s to %s",
            granularity.value,
            from_timestamp,
            to_timestamp,
        )

        filters_sql = ""
        params: dict[str, object] = {"from_ts": from_timestamp, "to_ts": to_timestamp}
        if country_codes:
            filters_sql += " AND gl.country_code = ANY(:country_codes)"
            params["country_codes"] = [c.upper() for c in country_codes]
        if cities:
            filters_sql += " AND gl.city = ANY(:cities)"
            params["cities"] = cities
        # ge-aliased conditions are safe here: any of these filters forced the
        # RAW branch above, and only that branch joins geo_events as ge.
        if ip_addresses:
            filters_sql += " AND ge.ip_address = ANY(CAST(:filter_ips AS inet[]))"
            params["filter_ips"] = list(ip_addresses)
        if ip_addresses_exclude:
            filters_sql += " AND NOT (ge.ip_address = ANY(CAST(:filter_ips_excl AS inet[])))"
            params["filter_ips_excl"] = list(ip_addresses_exclude)
        if hostnames:
            filters_sql += " AND ge.hostname = ANY(:filter_hostnames)"
            params["filter_hostnames"] = list(hostnames)

        if granularity == StatsGranularity.RAW:
            # Query raw geo_events table for exact time range granularity
            stmt = text(f"""
                SELECT
                    gl.*,
                    CAST(COUNT(ge.id) AS INTEGER) AS event_count
                FROM geo_locations gl
                JOIN geo_events ge ON ge.location_id = gl.id
                WHERE ge.timestamp >= :from_ts AND ge.timestamp < :to_ts{filters_sql}
                GROUP BY gl.id
                ORDER BY event_count DESC, gl.id
            """)
        else:
            # Query appropriate CAGG
            table = f"location_{granularity.value}_stats"
            bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

            # Floor start time to bucket boundary for CAGG queries
            # Use CAST() instead of :: to avoid SQLAlchemy parameter parsing issues
            stmt = text(f"""
                SELECT
                    gl.*,
                    CAST(COALESCE(SUM(ls.event_count), 0) AS INTEGER) AS event_count
                FROM geo_locations gl
                JOIN {table} ls ON ls.location_id = gl.id
                WHERE ls.bucket >= time_bucket('{bucket_interval}', CAST(:from_ts AS timestamptz))
                  AND ls.bucket < :to_ts{filters_sql}
                GROUP BY gl.id
                ORDER BY event_count DESC, gl.id
            """)

        result = await self.session.execute(stmt, params)
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

        Routes to optimal source based on time range:
        - <= 24 hours: RAW geo_events table
        - > 24 hours, <= 30 days: ip_location_hourly_stats (stitched-exact)
        - > 30 days: ip_location_daily_stats (stitched-exact)

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

        granularity = get_stats_granularity(from_timestamp, to_timestamp)

        logger.debug(
            "get_location_top_ips: using %s for location %d, range %s to %s",
            granularity.value,
            location_id,
            from_timestamp,
            to_timestamp,
        )

        if granularity == StatsGranularity.RAW:
            stmt = text("""
                SELECT
                    ip_address,
                    CAST(COUNT(*) AS INTEGER) AS event_count
                FROM geo_events
                WHERE location_id = :location_id
                  AND timestamp >= :start AND timestamp < :end
                GROUP BY ip_address
                ORDER BY event_count DESC, ip_address
                LIMIT :limit
            """)
        else:
            # Stitched read: whole buckets from the hourly/daily per-IP CAGG,
            # partial head/tail from raw geo_events, so the window is exact.
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    ip_address,
                    CAST(SUM(event_count) AS INTEGER) AS event_count
                FROM combined
                WHERE location_id = :location_id
                GROUP BY ip_address
                ORDER BY event_count DESC, ip_address
                LIMIT :limit
            """)

        if granularity == StatsGranularity.RAW:
            params: dict = {"start": from_timestamp, "end": to_timestamp}
        else:
            params = stitch_params(from_timestamp, to_timestamp, granularity)
        result = await self.session.execute(
            stmt, {"location_id": location_id, "limit": limit, **params}
        )
        rows = result.fetchall()

        return [TopIP(ip_address=str(row.ip_address), event_count=row.event_count) for row in rows]

    async def get_global_top_ips(
        self, from_timestamp: datetime, to_timestamp: datetime, limit: int = 5
    ) -> list[tuple[str, int, GeoLocation]]:
        """Get global top N IPs by event count with their primary location.

        Routes to optimal source based on time range:
        - <= 24 hours: RAW geo_events table
        - > 24 hours, <= 30 days: ip_location_hourly_stats (stitched-exact)
        - > 30 days: ip_location_daily_stats (stitched-exact)

        For IPs that appear in multiple locations, returns the location
        where they have the highest event count.

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
            limit: Maximum number of IPs to return.

        Returns:
            List of tuples containing (ip_address, event_count, GeoLocation).
        """
        granularity = get_stats_granularity(from_timestamp, to_timestamp)

        logger.debug(
            "get_global_top_ips: using %s for range %s to %s",
            granularity.value,
            from_timestamp,
            to_timestamp,
        )

        if granularity == StatsGranularity.RAW:
            stmt = text("""
                SELECT
                    CAST(COUNT(*) AS INTEGER) AS total_count,
                    location_id,
                    ip_address
                FROM geo_events
                WHERE timestamp >= :start AND timestamp < :end
                GROUP BY location_id, ip_address
                ORDER BY total_count DESC, location_id, ip_address
                LIMIT :fetch_limit
            """)
        else:
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    CAST(SUM(event_count) AS INTEGER) AS total_count,
                    location_id,
                    ip_address
                FROM combined
                GROUP BY location_id, ip_address
                ORDER BY total_count DESC, location_id, ip_address
                LIMIT :fetch_limit
            """)

        if granularity == StatsGranularity.RAW:
            params: dict = {"start": from_timestamp, "end": to_timestamp}
        else:
            params = stitch_params(from_timestamp, to_timestamp, granularity)
        result = await self.session.execute(stmt, {
            **params,
            "fetch_limit": limit * 10,  # Fetch more to account for deduplication
        })

        # Dedupe by IP, keeping highest count location
        seen_ips: set[str] = set()
        top_ips: list[tuple[str, int, GeoLocation]] = []
        for total_count, loc_id, ip in result.all():
            if ip not in seen_ips and len(top_ips) < limit:
                seen_ips.add(ip)
                location = await self.session.get(GeoLocation, loc_id)
                if location:
                    top_ips.append((ip, total_count, location))

        return top_ips

    async def get_top_countries(
        self, from_timestamp: datetime, to_timestamp: datetime, limit: int = 10
    ) -> list[tuple[str, str | None, int]]:
        """Get top N countries by event count.

        Routes to optimal source based on time range:
        - ≤ 24 hours: RAW geo_events + geo_locations tables
        - > 24 hours, ≤ 30 days: location_hourly_stats CAGG
        - > 30 days: location_daily_stats CAGG

        Args:
            from_timestamp: Start datetime for filtering events.
            to_timestamp: End datetime for filtering events.
            limit: Maximum number of countries to return.

        Returns:
            List of tuples containing (country_code, country_name, event_count).
        """
        if not isinstance(from_timestamp, datetime) or not isinstance(to_timestamp, datetime):
            raise ValueError("from_timestamp and to_timestamp must be datetime instances")
        if not from_timestamp.tzinfo or not to_timestamp.tzinfo:
            raise ValueError("from_timestamp and to_timestamp must be timezone-aware")

        granularity = get_stats_granularity(from_timestamp, to_timestamp)

        logger.debug(
            "get_top_countries: using %s for range %s to %s",
            granularity.value,
            from_timestamp,
            to_timestamp,
        )

        if granularity == StatsGranularity.RAW:
            # Query raw geo_events + geo_locations tables for exact time range granularity
            stmt = text("""
                SELECT
                    gl.country_code,
                    gl.country_name,
                    CAST(COUNT(ge.id) AS INTEGER) AS event_count
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :from_ts AND ge.timestamp < :to_ts
                  AND gl.country_code IS NOT NULL
                GROUP BY gl.country_code, gl.country_name
                ORDER BY event_count DESC, gl.country_code
                LIMIT :limit
            """)
        else:
            # Query appropriate CAGG joined with geo_locations
            table = f"location_{granularity.value}_stats"
            bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

            stmt = text(f"""
                SELECT
                    gl.country_code,
                    gl.country_name,
                    CAST(COALESCE(SUM(ls.event_count), 0) AS INTEGER) AS event_count
                FROM {table} ls
                JOIN geo_locations gl ON ls.location_id = gl.id
                WHERE ls.bucket >= time_bucket('{bucket_interval}', CAST(:from_ts AS timestamptz))
                  AND ls.bucket < :to_ts
                  AND gl.country_code IS NOT NULL
                GROUP BY gl.country_code, gl.country_name
                ORDER BY event_count DESC, gl.country_code
                LIMIT :limit
            """)

        result = await self.session.execute(
            stmt,
            {
                "from_ts": from_timestamp,
                "to_ts": to_timestamp,
                "limit": limit,
            },
        )
        rows = result.fetchall()

        return [(row.country_code, row.country_name, row.event_count) for row in rows]


class GeoEventRepository(SQLAlchemyAsyncRepository[GeoEvent]):
    """Repository for GeoEvent model."""

    model_type = GeoEvent
    
    