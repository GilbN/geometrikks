"""Repositories for analytics data access.

Query Routing:
- RAW (hypertables): For time ranges ≤ 24 hours (exact granularity needed)
- Hourly CAGGs: For time ranges > 24 hours and ≤ 30 days
- Daily CAGGs: For time ranges > 30 days

Note: We use hourly CAGGs for up to 30 days because they properly support
real-time aggregation. Daily CAGGs have watermark limitations that can cause
staleness for the current day.

CAGG Structure:
- summary_hourly_stats / summary_daily_stats: Access log metrics (requests, bytes, status codes, latency)
- geo_summary_hourly_stats / geo_summary_daily_stats: Geo metrics with HyperLogLog (events, unique IPs/countries/cities)
- location_hourly_stats / location_daily_stats: Location event counts for map (GeoJSON features)
- ip_location_daily_stats: Per-IP counts by location for top IPs

HyperLogLog sketches enable accurate unique counts across any time range.
For short ranges (≤1 hour), raw table queries provide exact time range results.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Sequence
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

class StatsGranularity(Enum):
    """Granularity for query routing."""

    RAW = "raw"  # Raw hypertables (≤ 24 hours) - exact granularity
    HOURLY = "hourly"  # hourly CAGGs (> 24 hours, ≤ 30 days)
    DAILY = "daily"  # daily CAGGs (> 30 days)


def get_stats_granularity(start: datetime, end: datetime) -> StatsGranularity:
    """Determine the optimal query source based on time range duration.

    Routing logic:
    - ≤ 24 hours: RAW (query hypertables for exact granularity)
    - > 24 hours, ≤ 30 days: HOURLY CAGG (real-time aggregation provides fresh data)
    - > 30 days: DAILY CAGG (some staleness acceptable for long ranges)

    Note: We use hourly CAGG for up to 30 days because daily CAGGs can't
    do real-time aggregation for the current day (watermark is at next day).

    Args:
        start: Start of time range.
        end: End of time range.

    Returns:
        StatsGranularity indicating which source to query.
    """
    duration = end - start

    if duration <= timedelta(hours=24):
        return StatsGranularity.RAW
    elif duration <= timedelta(days=30):
        return StatsGranularity.HOURLY
    return StatsGranularity.DAILY


def _floor_to_hour(dt: datetime) -> datetime:
    """Truncate datetime to the start of its hour."""
    result = dt.replace(minute=0, second=0, microsecond=0)
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result


def _ceil_to_hour(dt: datetime) -> datetime:
    """Round datetime up to the next hour (or same if already at hour boundary)."""
    if dt.minute == 0 and dt.second == 0 and dt.microsecond == 0:
        result = dt
    else:
        result = dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result


@dataclass
class SummaryStatsRow:
    """A row from summary stats CAGGs."""

    bucket: datetime
    total_requests: int
    total_bytes: int
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float
    p50_request_time: float
    p95_request_time: float
    p99_request_time: float


@dataclass
class SummaryStats:
    """Aggregated summary statistics for a time period."""

    # Access log metrics
    total_log_records: int
    total_bytes: int
    avg_bytes_per_request: float
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float
    p50_request_time: float
    p95_request_time: float
    p99_request_time: float
    error_rate: float

    # Geo metrics (from HyperLogLog)
    total_geo_records: int
    unique_ips: int
    unique_countries: int
    unique_cities: int

    # Optional fields for backwards compatibility
    malformed_requests: int = 0

    @property
    def total_bytes_sent(self) -> int:
        """Alias for total_bytes (backwards compatibility)."""
        return self.total_bytes


class SummaryStatsRepository:
    """Repository for querying summary statistics from CAGGs.

    Combines data from:
    - summary_hourly_stats / summary_daily_stats: Access log metrics
    - geo_summary_hourly_stats / geo_summary_daily_stats: Geo metrics with HyperLogLog
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_summary(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get combined summary stats for a time range.

        Routes to optimal source based on time range:
        - ≤ 24 hours: RAW hypertables (exact granularity)
        - > 24 hours, ≤ 30 days: hourly CAGGs with HyperLogLog
        - > 30 days: daily CAGGs with HyperLogLog

        Args:
            start: Start datetime.
            end: End datetime.
        Returns:
            SummaryStats or None if no data.
        Raises:
            ValueError: If start or end are not timezone-aware datetimes.
        """
        if not isinstance(start, datetime) or not isinstance(end, datetime):
            raise ValueError("start and end must be datetime instances")
        if not start.tzinfo or not end.tzinfo:
            raise ValueError("start and end must be timezone-aware")

        granularity = get_stats_granularity(start, end)

        logger.debug(f"Fetching summary stats from {granularity.value} source for range {start} to {end}")
        
        if granularity == StatsGranularity.RAW:
            return await self._get_summary_from_raw(start, end)
        else:
            return await self._get_summary_from_cagg(start, end, granularity)

    async def _get_summary_from_raw(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get summary stats by querying raw hypertables.

        Provides exact time range granularity for short ranges.
        """
        # Query AccessLog for request metrics
        access_stmt = text("""
            SELECT
                COUNT(*) AS total_log_records,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                COALESCE(AVG(request_time), 0) AS avg_request_time,
                COALESCE(MAX(request_time), 0) AS max_request_time,
                COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time), 0) AS p50_request_time,
                COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time), 0) AS p95_request_time,
                COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time), 0) AS p99_request_time
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end
        """)

        access_result = await self.session.execute(access_stmt, {"start": start, "end": end})
        access_row = access_result.one_or_none()

        # Query GeoEvent + GeoLocation for geo metrics with accurate unique counts
        geo_stmt = text("""
            SELECT
                COUNT(*) AS total_geo_records,
                COUNT(DISTINCT ge.ip_address) AS unique_ips,
                COUNT(DISTINCT gl.country_code) AS unique_countries,
                COUNT(DISTINCT gl.city) AS unique_cities
            FROM geo_events ge
            JOIN geo_locations gl ON ge.location_id = gl.id
            WHERE ge.timestamp >= :start AND ge.timestamp < :end
        """)

        geo_result = await self.session.execute(geo_stmt, {"start": start, "end": end})
        geo_row = geo_result.one_or_none()

        # Query malformed requests from debug table
        malformed_stmt = text("""
            SELECT COUNT(*) AS malformed_requests
            FROM access_log_debug
            WHERE created_at >= :start AND created_at < :end
              AND is_malformed = true
        """)

        malformed_result = await self.session.execute(malformed_stmt, {"start": start, "end": end})
        malformed_row = malformed_result.one_or_none()

        total_log_records = access_row.total_log_records if access_row else 0
        total_geo_records = geo_row.total_geo_records if geo_row else 0

        if total_log_records == 0 and total_geo_records == 0:
            return None

        total_errors = ((access_row.status_4xx or 0) + (access_row.status_5xx or 0)) if access_row else 0
        error_rate = total_errors / total_log_records if total_log_records > 0 else 0.0
        avg_bytes = (access_row.total_bytes if access_row else 0) / total_log_records if total_log_records > 0 else 0.0

        return SummaryStats(
            total_log_records=total_log_records,
            total_bytes=access_row.total_bytes if access_row else 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=access_row.status_2xx if access_row else 0,
            status_3xx=access_row.status_3xx if access_row else 0,
            status_4xx=access_row.status_4xx if access_row else 0,
            status_5xx=access_row.status_5xx if access_row else 0,
            avg_request_time=float(access_row.avg_request_time or 0.0) if access_row else 0.0,
            max_request_time=float(access_row.max_request_time or 0.0) if access_row else 0.0,
            p50_request_time=float(access_row.p50_request_time or 0.0) if access_row else 0.0,
            p95_request_time=float(access_row.p95_request_time or 0.0) if access_row else 0.0,
            p99_request_time=float(access_row.p99_request_time or 0.0) if access_row else 0.0,
            error_rate=error_rate,
            total_geo_records=total_geo_records,
            unique_ips=geo_row.unique_ips if geo_row else 0,
            unique_countries=geo_row.unique_countries if geo_row else 0,
            unique_cities=geo_row.unique_cities if geo_row else 0,
            malformed_requests=malformed_row.malformed_requests if malformed_row else 0,
        )

    async def _get_summary_from_cagg(
        self,
        start: datetime,
        end: datetime,
        granularity: StatsGranularity,
    ) -> SummaryStats | None:
        """Get summary stats from continuous aggregates.

        Uses HyperLogLog rollup for accurate unique counts.
        """
        summary_table = f"summary_{granularity.value}_stats"
        geo_table = f"geo_summary_{granularity.value}_stats"
        bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

        # Combined query for access log, geo metrics, and malformed requests
        # Floor start time to bucket boundary for CAGG queries
        stmt = text(f"""
            SELECT
                log.total_log_records,
                log.total_bytes,
                log.status_2xx,
                log.status_3xx,
                log.status_4xx,
                log.status_5xx,
                log.avg_request_time,
                log.max_request_time,
                log.p50_request_time,
                log.p95_request_time,
                log.p99_request_time,
                geo.total_geo_records,
                geo.unique_ips,
                geo.unique_countries,
                geo.unique_cities,
                mal.malformed_requests
            FROM (
                SELECT
                    COALESCE(SUM(total_requests), 0) AS total_log_records,
                    COALESCE(SUM(total_bytes), 0) AS total_bytes,
                    COALESCE(SUM(status_2xx), 0) AS status_2xx,
                    COALESCE(SUM(status_3xx), 0) AS status_3xx,
                    COALESCE(SUM(status_4xx), 0) AS status_4xx,
                    COALESCE(SUM(status_5xx), 0) AS status_5xx,
                    COALESCE(AVG(avg_request_time), 0) AS avg_request_time,
                    COALESCE(MAX(max_request_time), 0) AS max_request_time,
                    COALESCE(approx_percentile(0.50, rollup(pct_agg)), 0) AS p50_request_time,
                    COALESCE(approx_percentile(0.95, rollup(pct_agg)), 0) AS p95_request_time,
                    COALESCE(approx_percentile(0.99, rollup(pct_agg)), 0) AS p99_request_time
                FROM {summary_table}
                WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
                AND bucket < :end
            ) log
            CROSS JOIN (
                SELECT
                    COALESCE(SUM(total_events), 0) AS total_geo_records,
                    COALESCE(distinct_count(rollup(hll_ips)), 0) AS unique_ips,
                    COALESCE(distinct_count(rollup(hll_countries)), 0) AS unique_countries,
                    COALESCE(distinct_count(rollup(hll_cities)), 0) AS unique_cities
                FROM {geo_table}
                WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
                AND bucket < :end
            ) geo
            CROSS JOIN (
                SELECT COALESCE(COUNT(*), 0) AS malformed_requests
                FROM access_log_debug
                WHERE created_at >= :start AND created_at < :end
                AND is_malformed = true
            ) mal
        """)

        result = await self.session.execute(stmt, {"start": start, "end": end})
        row = result.one_or_none()

        if row is None or (row.total_log_records == 0 and row.total_geo_records == 0):
            return None

        total_errors = row.status_4xx + row.status_5xx
        error_rate = total_errors / row.total_log_records if row.total_log_records > 0 else 0.0
        avg_bytes = row.total_bytes / row.total_log_records if row.total_log_records > 0 else 0.0

        return SummaryStats(
            total_log_records=row.total_log_records,
            total_bytes=row.total_bytes,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx,
            status_3xx=row.status_3xx,
            status_4xx=row.status_4xx,
            status_5xx=row.status_5xx,
            avg_request_time=float(row.avg_request_time),
            max_request_time=float(row.max_request_time),
            p50_request_time=float(row.p50_request_time),
            p95_request_time=float(row.p95_request_time),
            p99_request_time=float(row.p99_request_time),
            error_rate=error_rate,
            total_geo_records=row.total_geo_records,
            unique_ips=row.unique_ips,
            unique_countries=row.unique_countries,
            unique_cities=row.unique_cities,
            malformed_requests=row.malformed_requests,
        )

    async def get_time_series(
        self,
        start: datetime,
        end: datetime,
    ) -> Sequence[SummaryStatsRow]:
        """Get time series data for charts.

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            List of SummaryStatsRow ordered by bucket ascending.
        """
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            granularity = StatsGranularity.HOURLY  # no raw CAGG; hourly + real-time agg covers ≤24h
        table = f"summary_{granularity.value}_stats"
        bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

        stmt = text(f"""
            SELECT
                bucket,
                total_requests,
                total_bytes,
                status_2xx,
                status_3xx,
                status_4xx,
                status_5xx,
                avg_request_time,
                max_request_time,
                approx_percentile(0.50, pct_agg) AS p50_request_time,
                approx_percentile(0.95, pct_agg) AS p95_request_time,
                approx_percentile(0.99, pct_agg) AS p99_request_time
            FROM {table}
            WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
              AND bucket < :end
            ORDER BY bucket ASC
        """)

        result = await self.session.execute(stmt, {"start": start, "end": end})
        rows = result.fetchall()

        return [
            SummaryStatsRow(
                bucket=row.bucket,
                total_requests=row.total_requests or 0,
                total_bytes=row.total_bytes or 0,
                status_2xx=row.status_2xx or 0,
                status_3xx=row.status_3xx or 0,
                status_4xx=row.status_4xx or 0,
                status_5xx=row.status_5xx or 0,
                avg_request_time=float(row.avg_request_time or 0.0),
                max_request_time=float(row.max_request_time or 0.0),
                p50_request_time=float(row.p50_request_time or 0.0),
                p95_request_time=float(row.p95_request_time or 0.0),
                p99_request_time=float(row.p99_request_time or 0.0),
            )
            for row in rows
        ]

    async def get_geo_time_series(
        self,
        start: datetime,
        end: datetime,
    ) -> Sequence[dict]:
        """Get geo event time series data for charts.

        Returns per-bucket counts and unique metrics (via HyperLogLog).

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            List of dicts with bucket, total_events, unique_ips, unique_countries, unique_cities.
        """
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            granularity = StatsGranularity.HOURLY  # no raw CAGG; hourly + real-time agg covers ≤24h
        table = f"geo_summary_{granularity.value}_stats"
        bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

        stmt = text(f"""
            SELECT
                bucket,
                total_events,
                distinct_count(hll_ips) AS unique_ips,
                distinct_count(hll_countries) AS unique_countries,
                distinct_count(hll_cities) AS unique_cities
            FROM {table}
            WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
              AND bucket < :end
            ORDER BY bucket ASC
        """)

        result = await self.session.execute(stmt, {"start": start, "end": end})
        return [dict(row._mapping) for row in result.fetchall()]

    async def get_cumulative_time_series(
        self,
        start: datetime,
        end: datetime,
    ) -> Sequence[dict]:
        """Get cumulative time series data for area charts.

        Returns running totals for geo events, access logs, and bytes
        that reset at the start of the selected time range.

        Routes to optimal source based on time range:
        - ≤ 24 hours: RAW tables (access_logs, geo_events) bucketed by hour
        - > 24 hours, ≤ 30 days: hourly CAGGs
        - > 30 days: daily CAGGs

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            List of dicts with timestamp and cumulative values.
        """
        if not isinstance(start, datetime) or not isinstance(end, datetime):
            raise ValueError("start and end must be datetime instances")
        if not start.tzinfo or not end.tzinfo:
            raise ValueError("start and end must be timezone-aware")

        granularity = get_stats_granularity(start, end)

        logger.debug(f"Fetching cumulative time series from {granularity.value} source for range {start} to {end}")

        if granularity == StatsGranularity.RAW:
            # Query raw tables with time_bucket for ≤24h ranges
            stmt = text("""
                WITH hourly_access AS (
                    SELECT
                        time_bucket('1 hour', timestamp) AS bucket,
                        COUNT(*) AS access_logs,
                        COALESCE(SUM(bytes_sent), 0) AS bytes
                    FROM access_logs
                    WHERE timestamp >= :start AND timestamp < :end
                    GROUP BY bucket
                ),
                hourly_geo AS (
                    SELECT
                        time_bucket('1 hour', timestamp) AS bucket,
                        COUNT(*) AS geo_events
                    FROM geo_events
                    WHERE timestamp >= :start AND timestamp < :end
                    GROUP BY bucket
                ),
                combined AS (
                    SELECT
                        COALESCE(a.bucket, g.bucket) AS bucket,
                        COALESCE(a.access_logs, 0) AS access_logs,
                        COALESCE(a.bytes, 0) AS bytes,
                        COALESCE(g.geo_events, 0) AS geo_events
                    FROM hourly_access a
                    FULL OUTER JOIN hourly_geo g ON a.bucket = g.bucket
                )
                SELECT
                    bucket AS timestamp,
                    SUM(geo_events) OVER (ORDER BY bucket) AS cumulative_geo_events,
                    SUM(access_logs) OVER (ORDER BY bucket) AS cumulative_access_logs,
                    SUM(bytes) OVER (ORDER BY bucket) AS cumulative_bytes
                FROM combined
                ORDER BY bucket ASC
            """)
        else:
            # Query CAGGs for longer ranges
            summary_table = f"summary_{granularity.value}_stats"
            geo_table = f"geo_summary_{granularity.value}_stats"
            bucket_interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"

            stmt = text(f"""
                WITH summary_data AS (
                    SELECT
                        bucket,
                        COALESCE(total_requests, 0) AS access_logs,
                        COALESCE(total_bytes, 0) AS bytes
                    FROM {summary_table}
                    WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
                      AND bucket < :end
                ),
                geo_data AS (
                    SELECT
                        bucket,
                        COALESCE(total_events, 0) AS geo_events
                    FROM {geo_table}
                    WHERE bucket >= time_bucket('{bucket_interval}', CAST(:start AS timestamptz))
                      AND bucket < :end
                ),
                combined AS (
                    SELECT
                        COALESCE(s.bucket, g.bucket) AS bucket,
                        COALESCE(s.access_logs, 0) AS access_logs,
                        COALESCE(s.bytes, 0) AS bytes,
                        COALESCE(g.geo_events, 0) AS geo_events
                    FROM summary_data s
                    FULL OUTER JOIN geo_data g ON s.bucket = g.bucket
                )
                SELECT
                    bucket AS timestamp,
                    SUM(geo_events) OVER (ORDER BY bucket) AS cumulative_geo_events,
                    SUM(access_logs) OVER (ORDER BY bucket) AS cumulative_access_logs,
                    SUM(bytes) OVER (ORDER BY bucket) AS cumulative_bytes
                FROM combined
                ORDER BY bucket ASC
            """)

        result = await self.session.execute(stmt, {"start": start, "end": end})
        return [dict(row._mapping) for row in result.fetchall()]


@dataclass
class TopUrlRow:
    """A top-URL aggregate row from raw access_logs."""

    url: str
    hits: int
    error_hits: int
    total_bytes: int
    avg_request_time: float


@dataclass
class TopUserAgentRow:
    """A top-user-agent aggregate row from raw access_logs."""

    user_agent: str
    hits: int


class LiveStatsRepository:
    """Repository for querying live statistics directly from raw hypertables.

    Queries AccessLog, GeoEvent, and GeoLocation directly instead of
    using continuous aggregates. Provides real-time accuracy at the cost
    of query performance.

    Note: With TimescaleDB hypertables, these queries benefit from:
    - Chunk exclusion (only scans relevant time chunks)
    - Parallel chunk scanning
    - Compression on older chunks
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_summary(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get live summary stats by querying raw hypertables.

        Unlike SummaryStatsRepository.get_summary which uses continuous
        aggregates with HyperLogLog, this queries the raw tables directly
        for maximum accuracy.

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            SummaryStats with live values, or None if no data.
        """
        # Query AccessLog for request metrics
        access_stmt = text("""
            SELECT
                COUNT(*) AS total_requests,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                COALESCE(AVG(request_time), 0) AS avg_request_time,
                COALESCE(MAX(request_time), 0) AS max_request_time,
                COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time), 0) AS p50_request_time,
                COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time), 0) AS p95_request_time,
                COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time), 0) AS p99_request_time
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end
        """)

        access_result = await self.session.execute(access_stmt, {"start": start, "end": end})
        access_row = access_result.one_or_none()

        # Query GeoEvent + GeoLocation for geo metrics with accurate unique counts
        geo_stmt = text("""
            SELECT
                COUNT(*) AS total_events,
                COUNT(DISTINCT ge.ip_address) AS unique_ips,
                COUNT(DISTINCT gl.country_code) AS unique_countries,
                COUNT(DISTINCT gl.city) AS unique_cities
            FROM geo_events ge
            JOIN geo_locations gl ON ge.location_id = gl.id
            WHERE ge.timestamp >= :start AND ge.timestamp < :end
        """)

        geo_result = await self.session.execute(geo_stmt, {"start": start, "end": end})
        geo_row = geo_result.one_or_none()

        # Query malformed requests from debug table
        malformed_stmt = text("""
            SELECT COUNT(*) AS malformed_requests
            FROM access_log_debug
            WHERE created_at >= :start AND created_at < :end
              AND is_malformed = true
        """)

        malformed_result = await self.session.execute(malformed_stmt, {"start": start, "end": end})
        malformed_row = malformed_result.one_or_none()

        total_requests = access_row.total_requests if access_row else 0
        total_events = geo_row.total_events if geo_row else 0

        if total_requests == 0 and total_events == 0:
            return None

        total_errors = ((access_row.status_4xx or 0) + (access_row.status_5xx or 0)) if access_row else 0
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = (access_row.total_bytes if access_row else 0) / total_requests if total_requests > 0 else 0.0

        return SummaryStats(
            total_log_records=total_requests,
            total_bytes=access_row.total_bytes if access_row else 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=access_row.status_2xx if access_row else 0,
            status_3xx=access_row.status_3xx if access_row else 0,
            status_4xx=access_row.status_4xx if access_row else 0,
            status_5xx=access_row.status_5xx if access_row else 0,
            avg_request_time=float(access_row.avg_request_time or 0.0) if access_row else 0.0,
            max_request_time=float(access_row.max_request_time or 0.0) if access_row else 0.0,
            p50_request_time=float(access_row.p50_request_time or 0.0) if access_row else 0.0,
            p95_request_time=float(access_row.p95_request_time or 0.0) if access_row else 0.0,
            p99_request_time=float(access_row.p99_request_time or 0.0) if access_row else 0.0,
            error_rate=error_rate,
            total_geo_records=total_events,
            unique_ips=geo_row.unique_ips if geo_row else 0,
            unique_countries=geo_row.unique_countries if geo_row else 0,
            unique_cities=geo_row.unique_cities if geo_row else 0,
            malformed_requests=malformed_row.malformed_requests if malformed_row else 0,
        )

    async def get_top_urls(
        self, start: datetime, end: datetime, limit: int = 25
    ) -> list[TopUrlRow]:
        """Top URLs by hit count from raw access_logs (time-bounded).

        Raw-table scan by design: no CAGG exists for URL cardinality yet
        (future optimization; fine at homelab volume with chunk exclusion).
        """
        stmt = text("""
            SELECT
                url,
                CAST(COUNT(*) AS BIGINT) AS hits,
                CAST(COUNT(*) FILTER (WHERE status_code >= 400) AS BIGINT) AS error_hits,
                CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes,
                COALESCE(AVG(request_time), 0) AS avg_request_time
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND url IS NOT NULL
            GROUP BY url
            ORDER BY hits DESC
            LIMIT :limit
        """)
        result = await self.session.execute(stmt, {"start": start, "end": end, "limit": limit})
        return [
            TopUrlRow(
                url=row.url,
                hits=row.hits,
                error_hits=row.error_hits,
                total_bytes=row.total_bytes,
                avg_request_time=float(row.avg_request_time),
            )
            for row in result.fetchall()
        ]

    async def get_top_user_agents(
        self, start: datetime, end: datetime, limit: int = 25
    ) -> list[TopUserAgentRow]:
        """Top user agents by hit count from raw access_logs (time-bounded)."""
        stmt = text("""
            SELECT user_agent, CAST(COUNT(*) AS BIGINT) AS hits
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND user_agent IS NOT NULL
            GROUP BY user_agent
            ORDER BY hits DESC
            LIMIT :limit
        """)
        result = await self.session.execute(stmt, {"start": start, "end": end, "limit": limit})
        return [TopUserAgentRow(user_agent=row.user_agent, hits=row.hits) for row in result.fetchall()]
