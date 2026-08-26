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
- url_hourly_stats / url_daily_stats: Top URLs by hits, error_hits, total_bytes, total_request_time
- user_agent_hourly_stats / user_agent_daily_stats: Top user agents by hits
- log_ip_{hourly,daily}_stats: Per-IP access-log counts (top IPs/countries/cities, facets)

HyperLogLog sketches enable accurate unique counts across any time range.
For short ranges (≤1 hour), raw table queries provide exact time range results.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Sequence, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

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


def use_local_days(
    granularity: StatsGranularity,
    start: datetime,
    end: datetime,
    tz: str | None,
) -> bool:
    """True when daily buckets should be local days in ``tz``.

    Daily buckets in a non-UTC zone can only be assembled from hourly source
    data. Ranges that route to the daily CAGGs (> 30 days) keep UTC day
    buckets: hourly CAGG retention is not guaranteed to reach that far back,
    and the daily CAGGs are baked as UTC days.
    """
    return (
        granularity == StatsGranularity.DAILY
        and tz is not None
        and tz != "UTC"
        and get_stats_granularity(start, end) != StatsGranularity.DAILY
    )


def _optional_float(value: object) -> float | None:
    """A timing aggregate is None when the range had no measured rows."""
    return float(cast("float", value)) if value is not None else None


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
    avg_request_time: float | None
    max_request_time: float | None
    p50_request_time: float | None
    p95_request_time: float | None
    p99_request_time: float | None
    timed_requests: int = 0


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
    avg_request_time: float | None
    max_request_time: float | None
    p50_request_time: float | None
    p95_request_time: float | None
    p99_request_time: float | None
    error_rate: float

    # Geo metrics (from HyperLogLog)
    total_geo_records: int
    unique_ips: int
    unique_countries: int
    unique_cities: int

    # Optional fields for backwards compatibility
    malformed_requests: int = 0
    timed_requests: int = 0

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
                COUNT(request_time) AS timed_requests,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time) AS p95_request_time,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time) AS p99_request_time
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
        avg_bytes = float(access_row.total_bytes if access_row else 0) / total_log_records if total_log_records > 0 else 0.0

        return SummaryStats(
            total_log_records=total_log_records,
            total_bytes=int(access_row.total_bytes) if access_row else 0,
            avg_bytes_per_request=float(avg_bytes),
            status_2xx=access_row.status_2xx if access_row else 0,
            status_3xx=access_row.status_3xx if access_row else 0,
            status_4xx=access_row.status_4xx if access_row else 0,
            status_5xx=access_row.status_5xx if access_row else 0,
            timed_requests=int(access_row.timed_requests) if access_row else 0,
            avg_request_time=_optional_float(access_row.avg_request_time) if access_row else None,
            max_request_time=_optional_float(access_row.max_request_time) if access_row else None,
            p50_request_time=_optional_float(access_row.p50_request_time) if access_row else None,
            p95_request_time=_optional_float(access_row.p95_request_time) if access_row else None,
            p99_request_time=_optional_float(access_row.p99_request_time) if access_row else None,
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
                log.timed_requests,
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
                    COALESCE(SUM(timed_requests), 0) AS timed_requests,
                    SUM(avg_request_time * timed_requests) / NULLIF(SUM(timed_requests), 0) AS avg_request_time,
                    MAX(max_request_time) AS max_request_time,
                    approx_percentile(0.50, rollup(pct_agg)) AS p50_request_time,
                    approx_percentile(0.95, rollup(pct_agg)) AS p95_request_time,
                    approx_percentile(0.99, rollup(pct_agg)) AS p99_request_time
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
        avg_bytes = float(row.total_bytes) / float(row.total_log_records) if row.total_log_records > 0 else 0.0

        return SummaryStats(
            total_log_records=row.total_log_records,
            total_bytes=int(row.total_bytes),
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx,
            status_3xx=row.status_3xx,
            status_4xx=row.status_4xx,
            status_5xx=row.status_5xx,
            timed_requests=int(row.timed_requests),
            avg_request_time=_optional_float(row.avg_request_time),
            max_request_time=_optional_float(row.max_request_time),
            p50_request_time=_optional_float(row.p50_request_time),
            p95_request_time=_optional_float(row.p95_request_time),
            p99_request_time=_optional_float(row.p99_request_time),
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
        granularity: StatsGranularity | None = None,
        tz: str | None = None,
    ) -> Sequence[SummaryStatsRow]:
        """Get time series data for charts.

        Args:
            start: Start datetime.
            end: End datetime.
            granularity: Explicit bucket granularity override. None auto-routes
                via get_stats_granularity (RAW is clamped to HOURLY).
            tz: IANA timezone for daily buckets. When set (and non-UTC), daily
                buckets are local days rolled up from the hourly CAGG; ranges
                routed to the daily CAGGs keep UTC days (see use_local_days).

        Returns:
            List of SummaryStatsRow ordered by bucket ascending.
        """
        if granularity is None:
            granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            granularity = StatsGranularity.HOURLY  # no raw CAGG; hourly + real-time agg covers <=24h

        if use_local_days(granularity, start, end, tz):
            # Local days assembled from hourly buckets: counts sum, sketches
            # merge via rollup(), and the mean is weighted by the timed rows
            # of each hour, so hours with unmeasured requests do not dilute
            # it. GROUP BY 1: a bare "bucket" would resolve to the source column.
            stmt = text("""
                SELECT
                    time_bucket('1 day', bucket, CAST(:tz AS TEXT)) AS bucket,
                    CAST(SUM(total_requests) AS BIGINT) AS total_requests,
                    CAST(COALESCE(SUM(total_bytes), 0) AS BIGINT) AS total_bytes,
                    CAST(SUM(status_2xx) AS BIGINT) AS status_2xx,
                    CAST(SUM(status_3xx) AS BIGINT) AS status_3xx,
                    CAST(SUM(status_4xx) AS BIGINT) AS status_4xx,
                    CAST(SUM(status_5xx) AS BIGINT) AS status_5xx,
                    CAST(COALESCE(SUM(timed_requests), 0) AS BIGINT) AS timed_requests,
                    SUM(avg_request_time * timed_requests)
                        / NULLIF(SUM(timed_requests), 0) AS avg_request_time,
                    MAX(max_request_time) AS max_request_time,
                    approx_percentile(0.50, rollup(pct_agg)) AS p50_request_time,
                    approx_percentile(0.95, rollup(pct_agg)) AS p95_request_time,
                    approx_percentile(0.99, rollup(pct_agg)) AS p99_request_time
                FROM summary_hourly_stats
                WHERE bucket >= time_bucket('1 day', CAST(:start AS timestamptz), CAST(:tz AS TEXT))
                  AND bucket < :end
                GROUP BY 1
                ORDER BY 1 ASC
            """)
            params: dict = {"start": start, "end": end, "tz": tz}
        else:
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
                    timed_requests,
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
            params = {"start": start, "end": end}

        result = await self.session.execute(stmt, params)
        rows = result.fetchall()

        return [
            SummaryStatsRow(
                bucket=row.bucket,
                total_requests=row.total_requests or 0,
                total_bytes=int(row.total_bytes or 0),
                status_2xx=row.status_2xx or 0,
                status_3xx=row.status_3xx or 0,
                status_4xx=row.status_4xx or 0,
                status_5xx=row.status_5xx or 0,
                timed_requests=int(row.timed_requests or 0),
                avg_request_time=_optional_float(row.avg_request_time),
                max_request_time=_optional_float(row.max_request_time),
                p50_request_time=_optional_float(row.p50_request_time),
                p95_request_time=_optional_float(row.p95_request_time),
                p99_request_time=_optional_float(row.p99_request_time),
            )
            for row in rows
        ]

    async def get_geo_time_series(
        self,
        start: datetime,
        end: datetime,
        granularity: StatsGranularity | None = None,
        tz: str | None = None,
    ) -> Sequence[dict]:
        """Get geo event time series data for charts.

        Returns per-bucket counts and unique metrics (via HyperLogLog).

        Args:
            start: Start datetime.
            end: End datetime.
            granularity: Explicit bucket granularity override. None auto-routes
                via get_stats_granularity (RAW is clamped to HOURLY).
            tz: IANA timezone for daily buckets (see get_time_series).

        Returns:
            List of dicts with bucket, total_events, unique_ips, unique_countries, unique_cities.
        """
        if granularity is None:
            granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            granularity = StatsGranularity.HOURLY  # no raw CAGG; hourly + real-time agg covers <=24h

        if use_local_days(granularity, start, end, tz):
            # GROUP BY 1: a bare "bucket" would resolve to the source column.
            stmt = text("""
                SELECT
                    time_bucket('1 day', bucket, CAST(:tz AS TEXT)) AS bucket,
                    CAST(SUM(total_events) AS BIGINT) AS total_events,
                    distinct_count(rollup(hll_ips)) AS unique_ips,
                    distinct_count(rollup(hll_countries)) AS unique_countries,
                    distinct_count(rollup(hll_cities)) AS unique_cities
                FROM geo_summary_hourly_stats
                WHERE bucket >= time_bucket('1 day', CAST(:start AS timestamptz), CAST(:tz AS TEXT))
                  AND bucket < :end
                GROUP BY 1
                ORDER BY 1 ASC
            """)
            params: dict = {"start": start, "end": end, "tz": tz}
        else:
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
            params = {"start": start, "end": end}

        result = await self.session.execute(stmt, params)
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

    async def get_top_urls(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopUrlRow]:
        """Top URLs by hits: stitched url CAGG read above 24h, raw otherwise.

        Any active filter forces the raw path: the url CAGGs carry no
        country/city/IP dimensions (adding them would multiply cardinality).
        """
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.is_active():
            return await LiveStatsRepository(self.session).get_top_urls(
                start, end, limit, filters=filters
            )
        table = f"url_{granularity.value}_stats"
        stmt = text(f"""
            WITH combined AS (
                SELECT s.url, s.hits, s.timed_hits, s.error_hits, s.total_bytes, s.total_request_time
                FROM {table} s
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
                SELECT al.url, CAST(1 AS BIGINT), CAST((al.request_time IS NOT NULL)::int AS BIGINT),
                       CAST((al.status_code >= 400)::int AS BIGINT), al.bytes_sent, al.request_time
                FROM access_logs al
                WHERE al.timestamp >= :start AND al.timestamp < :a_start
                  AND al.url IS NOT NULL
                UNION ALL
                SELECT al.url, CAST(1 AS BIGINT), CAST((al.request_time IS NOT NULL)::int AS BIGINT),
                       CAST((al.status_code >= 400)::int AS BIGINT), al.bytes_sent, al.request_time
                FROM access_logs al
                WHERE al.timestamp >= :a_end AND al.timestamp < :end
                  AND al.url IS NOT NULL
            )
            SELECT
                url,
                CAST(SUM(hits) AS BIGINT) AS hits,
                CAST(SUM(timed_hits) AS BIGINT) AS timed_hits,
                CAST(SUM(error_hits) AS BIGINT) AS error_hits,
                CAST(COALESCE(SUM(total_bytes), 0) AS BIGINT) AS total_bytes,
                SUM(total_request_time) / NULLIF(SUM(timed_hits), 0) AS avg_request_time
            FROM combined
            GROUP BY url
            ORDER BY hits DESC, url
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {**_stitch_params(start, end, granularity), "limit": limit}
        )
        return [
            TopUrlRow(
                url=row.url,
                hits=row.hits,
                error_hits=row.error_hits,
                total_bytes=row.total_bytes,
                timed_hits=row.timed_hits,
                avg_request_time=_optional_float(row.avg_request_time),
            )
            for row in result.fetchall()
        ]

    async def get_top_user_agents(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopUserAgentRow]:
        """Top user agents by hits: stitched CAGG read above 24h, raw otherwise.

        Any active filter forces the raw path (no dims on the UA CAGGs).
        """
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.is_active():
            return await LiveStatsRepository(self.session).get_top_user_agents(
                start, end, limit, filters=filters
            )
        table = f"user_agent_{granularity.value}_stats"
        stmt = text(f"""
            WITH combined AS (
                SELECT s.user_agent, s.hits
                FROM {table} s
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
                SELECT al.user_agent, CAST(1 AS BIGINT)
                FROM access_logs al
                WHERE al.timestamp >= :start AND al.timestamp < :a_start
                  AND al.user_agent IS NOT NULL
                UNION ALL
                SELECT al.user_agent, CAST(1 AS BIGINT)
                FROM access_logs al
                WHERE al.timestamp >= :a_end AND al.timestamp < :end
                  AND al.user_agent IS NOT NULL
            )
            SELECT user_agent, CAST(SUM(hits) AS BIGINT) AS hits
            FROM combined
            GROUP BY user_agent
            ORDER BY hits DESC, user_agent
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {**_stitch_params(start, end, granularity), "limit": limit}
        )
        return [
            TopUserAgentRow(user_agent=row.user_agent, hits=row.hits)
            for row in result.fetchall()
        ]

    async def get_top_asns(
        self, start: datetime, end: datetime, *, filters: AnalyticsFilters | None = None
    ) -> list[TopAsnRow]:
        """All ASNs by hits: stitched CAGG read above 24h, raw otherwise.

        No LIMIT: the endpoint needs every ASN for its category totals, and
        cardinality is a few thousand at most. Any active filter forces the
        raw path; the ASN CAGGs carry no filter dimensions.
        """
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.is_active():
            return await LiveStatsRepository(self.session).get_top_asns(
                start, end, filters=filters
            )
        table = f"asn_{granularity.value}_stats"
        stmt = text(f"""
            WITH combined AS (
                SELECT s.asn, s.as_org, s.hits, s.total_bytes
                FROM {table} s
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
                SELECT al.autonomous_system_number, al.autonomous_system_organization,
                       CAST(1 AS BIGINT), COALESCE(al.bytes_sent, 0)
                FROM access_logs al
                WHERE al.timestamp >= :start AND al.timestamp < :a_start
                  AND al.autonomous_system_number IS NOT NULL
                UNION ALL
                SELECT al.autonomous_system_number, al.autonomous_system_organization,
                       CAST(1 AS BIGINT), COALESCE(al.bytes_sent, 0)
                FROM access_logs al
                WHERE al.timestamp >= :a_end AND al.timestamp < :end
                  AND al.autonomous_system_number IS NOT NULL
            )
            SELECT asn,
                   MAX(as_org) AS organization,
                   CAST(SUM(hits) AS BIGINT) AS hits,
                   CAST(COALESCE(SUM(total_bytes), 0) AS BIGINT) AS total_bytes
            FROM combined
            GROUP BY asn
            ORDER BY hits DESC, asn
        """)
        result = await self.session.execute(stmt, _stitch_params(start, end, granularity))
        return [
            TopAsnRow(
                asn=row.asn,
                organization=row.organization,
                hits=row.hits,
                total_bytes=row.total_bytes,
            )
            for row in result.fetchall()
        ]

    async def get_request_totals(
        self, start: datetime, end: datetime, *, filters: AnalyticsFilters | None = None
    ) -> tuple[int, int]:
        """(total_requests, total_bytes) for the range, with or without ASN data.

        The denominator for /top-asns coverage, since the ASN queries exclude
        rows without ASN data. Stitched exactly like get_top_asns (CAGG for
        whole buckets, raw for the partial edges) so the two sides of the
        division cover the same window; get_summary's bucket-rounded totals
        would report bucket slop as unenriched traffic. Filtered ranges scan
        raw access_logs, like every filtered top list.
        """
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.is_active():
            filter_sql, filter_params = filters.sql_conditions()
            stmt = text(f"""
                SELECT CAST(COUNT(*) AS BIGINT) AS hits,
                       CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes
                FROM access_logs
                WHERE timestamp >= :start AND timestamp < :end
                {filter_sql}
            """)
            row = (await self.session.execute(
                stmt, {"start": start, "end": end, **filter_params}
            )).one()
            return row.hits, row.total_bytes
        table = f"summary_{granularity.value}_stats"
        stmt = text(f"""
            WITH combined AS (
                SELECT s.total_requests AS hits, s.total_bytes
                FROM {table} s
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
                SELECT COUNT(*), COALESCE(SUM(bytes_sent), 0)
                FROM access_logs
                WHERE timestamp >= :start AND timestamp < :a_start
                UNION ALL
                SELECT COUNT(*), COALESCE(SUM(bytes_sent), 0)
                FROM access_logs
                WHERE timestamp >= :a_end AND timestamp < :end
            )
            SELECT CAST(COALESCE(SUM(hits), 0) AS BIGINT) AS hits,
                   CAST(COALESCE(SUM(total_bytes), 0) AS BIGINT) AS total_bytes
            FROM combined
        """)
        row = (await self.session.execute(stmt, _stitch_params(start, end, granularity))).one()
        return row.hits, row.total_bytes

    def _log_ip_combined_cte(self, granularity: StatsGranularity) -> str:
        """WITH clause exposing ``combined`` for a stitched log_ip CAGG read.

        ``combined`` yields (ip_address, country_code, city, country_name,
        hits, error_hits, total_bytes); rows are keyed by IP on all legs, so
        COUNT(DISTINCT ip_address) over it stays exact and the unaliased
        AnalyticsFilters conditions apply to any leg's rows. Callers bind the
        params from ``_stitch_params``.
        """
        table = f"log_ip_{granularity.value}_stats"
        return f"""
            WITH combined AS (
                SELECT s.ip_address, s.country_code, s.city, s.country_name,
                       s.hits, s.error_hits, s.total_bytes
                FROM {table} s
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
                SELECT al.ip_address, al.country_code, al.city, al.country_name,
                       CAST(1 AS BIGINT), CAST((al.status_code >= 400)::int AS BIGINT),
                       al.bytes_sent
                FROM access_logs al
                WHERE al.timestamp >= :start AND al.timestamp < :a_start
                UNION ALL
                SELECT al.ip_address, al.country_code, al.city, al.country_name,
                       CAST(1 AS BIGINT), CAST((al.status_code >= 400)::int AS BIGINT),
                       al.bytes_sent
                FROM access_logs al
                WHERE al.timestamp >= :a_end AND al.timestamp < :end
            )
        """

    async def get_top_ips(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopIpRow]:
        """Top client IPs: stitched log_ip CAGG read above 24h, raw otherwise.

        Country/city/IP filters apply on the CAGG path (its columns carry the
        dimensions), so filtered long ranges stay fast.
        """
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            return await LiveStatsRepository(self.session).get_top_ips(
                start, end, limit, filters=filters
            )
        filter_sql, filter_params = filters.sql_conditions()
        stmt = text(f"""
            {self._log_ip_combined_cte(granularity)}
            SELECT
                host(ip_address) AS ip_address,
                CAST(SUM(hits) AS BIGINT) AS hits,
                CAST(SUM(error_hits) AS BIGINT) AS error_hits,
                CAST(COALESCE(SUM(total_bytes), 0) AS BIGINT) AS total_bytes,
                MAX(country_code) AS country_code,
                MAX(city) AS city
            FROM combined
            WHERE TRUE {filter_sql}
            GROUP BY ip_address
            ORDER BY hits DESC, ip_address
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {**_stitch_params(start, end, granularity), "limit": limit, **filter_params}
        )
        return [TopIpRow(**row._mapping) for row in result.fetchall()]

    async def get_top_countries(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopCountryRow]:
        """Top countries with exact unique-IP counts (combined is IP-keyed)."""
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            return await LiveStatsRepository(self.session).get_top_countries(
                start, end, limit, filters=filters
            )
        filter_sql, filter_params = filters.sql_conditions()
        stmt = text(f"""
            {self._log_ip_combined_cte(granularity)}
            SELECT
                country_code,
                MAX(country_name) AS country_name,
                CAST(SUM(hits) AS BIGINT) AS hits,
                CAST(COUNT(DISTINCT ip_address) AS BIGINT) AS unique_ips
            FROM combined
            WHERE country_code IS NOT NULL {filter_sql}
            GROUP BY country_code
            ORDER BY hits DESC, country_code
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {**_stitch_params(start, end, granularity), "limit": limit, **filter_params}
        )
        return [TopCountryRow(**row._mapping) for row in result.fetchall()]

    async def get_top_cities(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopCityRow]:
        """Top cities with exact unique-IP counts (NULL cities excluded)."""
        filters = filters or AnalyticsFilters()
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW:
            return await LiveStatsRepository(self.session).get_top_cities(
                start, end, limit, filters=filters
            )
        filter_sql, filter_params = filters.sql_conditions()
        stmt = text(f"""
            {self._log_ip_combined_cte(granularity)}
            SELECT
                city,
                MAX(country_code) AS country_code,
                CAST(SUM(hits) AS BIGINT) AS hits,
                CAST(COUNT(DISTINCT ip_address) AS BIGINT) AS unique_ips
            FROM combined
            WHERE city IS NOT NULL {filter_sql}
            GROUP BY city
            ORDER BY hits DESC, city
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {**_stitch_params(start, end, granularity), "limit": limit, **filter_params}
        )
        return [TopCityRow(**row._mapping) for row in result.fetchall()]


@dataclass
class TopUrlRow:
    """A top-URL aggregate row from raw access_logs."""

    url: str
    hits: int
    error_hits: int
    total_bytes: int
    avg_request_time: float | None
    timed_hits: int


@dataclass
class TopUserAgentRow:
    """A top-user-agent aggregate row from raw access_logs."""

    user_agent: str
    hits: int


@dataclass
class TopAsnRow:
    """A top-ASN aggregate row (CAGG or raw access_logs)."""

    asn: int
    organization: str | None
    hits: int
    total_bytes: int


@dataclass
class TopIpRow:
    """A top-IP aggregate row from raw access_logs."""

    ip_address: str
    hits: int
    error_hits: int
    total_bytes: int
    country_code: str | None
    city: str | None


@dataclass
class TopCountryRow:
    """A top-country aggregate row from raw access_logs."""

    country_code: str
    country_name: str | None
    hits: int
    unique_ips: int


@dataclass
class TopCityRow:
    """A top-city aggregate row from raw access_logs."""

    city: str
    country_code: str | None
    hits: int
    unique_ips: int


@dataclass
class AnalyticsFilters:
    """Optional dimension filters for analytics queries.

    Filtered queries must hit raw access_logs: CAGGs aggregate globally and
    cannot be sliced by country/city/IP. An exclude-only filter counts as
    active for exactly that reason.
    """

    country_codes: Sequence[str] | None = None
    cities: Sequence[str] | None = None
    ip_addresses: Sequence[str] | None = None
    ip_exclude: Sequence[str] | None = None

    def is_active(self) -> bool:
        return bool(self.country_codes or self.cities or self.ip_addresses or self.ip_exclude)

    def sql_conditions(self) -> tuple[str, dict]:
        """WHERE-clause fragment (leading ``AND``) plus bound params."""
        clauses: list[str] = []
        params: dict = {}
        if self.country_codes:
            clauses.append("AND country_code = ANY(:filter_countries)")
            params["filter_countries"] = list(self.country_codes)
        if self.cities:
            clauses.append("AND city = ANY(:filter_cities)")
            params["filter_cities"] = list(self.cities)
        if self.ip_addresses:
            clauses.append("AND ip_address = ANY(CAST(:filter_ips AS inet[]))")
            params["filter_ips"] = list(self.ip_addresses)
        if self.ip_exclude:
            clauses.append("AND NOT (ip_address = ANY(CAST(:filter_ips_exclude AS inet[])))")
            params["filter_ips_exclude"] = list(self.ip_exclude)
        return " ".join(clauses), params


def _stitch_params(
    start: datetime, end: datetime, granularity: StatsGranularity
) -> dict:
    """Bind params for a stitched CAGG read: window edges + inward bucket snap.

    a_start/a_end snap the [start, end) window inward to whole buckets (UTC
    aligned, matching time_bucket); the CAGG leg reads [a_start, a_end) and
    the raw head/tail legs read [start, a_start) and [a_end, end), so the
    union is exactly equal to a raw scan of the window. Clamped so a window
    spanning no complete bucket degenerates to a pure raw scan.

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
                COUNT(request_time) AS timed_requests,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time) AS p95_request_time,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time) AS p99_request_time
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
        avg_bytes = float(access_row.total_bytes if access_row else 0) / float(total_requests) if total_requests > 0 else 0.0

        return SummaryStats(
            total_log_records=total_requests,
            total_bytes=int(access_row.total_bytes) if access_row else 0,
            avg_bytes_per_request=float(avg_bytes),
            status_2xx=access_row.status_2xx if access_row else 0,
            status_3xx=access_row.status_3xx if access_row else 0,
            status_4xx=access_row.status_4xx if access_row else 0,
            status_5xx=access_row.status_5xx if access_row else 0,
            timed_requests=int(access_row.timed_requests) if access_row else 0,
            avg_request_time=_optional_float(access_row.avg_request_time) if access_row else None,
            max_request_time=_optional_float(access_row.max_request_time) if access_row else None,
            p50_request_time=_optional_float(access_row.p50_request_time) if access_row else None,
            p95_request_time=_optional_float(access_row.p95_request_time) if access_row else None,
            p99_request_time=_optional_float(access_row.p99_request_time) if access_row else None,
            error_rate=error_rate,
            total_geo_records=total_events,
            unique_ips=geo_row.unique_ips if geo_row else 0,
            unique_countries=geo_row.unique_countries if geo_row else 0,
            unique_cities=geo_row.unique_cities if geo_row else 0,
            malformed_requests=malformed_row.malformed_requests if malformed_row else 0,
        )

    async def get_time_series(
        self,
        start: datetime,
        end: datetime,
        *,
        bucket_interval: str,
        filters: AnalyticsFilters | None = None,
        tz: str | None = None,
    ) -> Sequence[SummaryStatsRow]:
        """Bucketed access-log metrics from the raw hypertable.

        Used when dimension filters are active (CAGGs cannot filter).
        bucket_interval is '1 hour' or '1 day' (validated by the caller).
        With a non-UTC ``tz``, daily buckets are local days; raw rows carry
        exact timestamps, so this needs no range restriction.
        """
        if bucket_interval not in ("1 hour", "1 day"):
            raise ValueError("bucket_interval must be '1 hour' or '1 day'")
        local_days = bucket_interval == "1 day" and tz is not None and tz != "UTC"
        bucket_expr = (
            "time_bucket('1 day', timestamp, CAST(:tz AS TEXT))"
            if local_days
            else f"time_bucket('{bucket_interval}', timestamp)"
        )
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        if local_days:
            filter_params = {**filter_params, "tz": tz}
        stmt = text(f"""
            SELECT
                {bucket_expr} AS bucket,
                CAST(COUNT(*) AS BIGINT) AS total_requests,
                CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                COUNT(request_time) AS timed_requests,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time) AS p95_request_time,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time) AS p99_request_time
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end
            {filter_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, **filter_params}
        )
        return [
            SummaryStatsRow(
                bucket=row.bucket,
                total_requests=row.total_requests or 0,
                total_bytes=int(row.total_bytes or 0),
                status_2xx=row.status_2xx or 0,
                status_3xx=row.status_3xx or 0,
                status_4xx=row.status_4xx or 0,
                status_5xx=row.status_5xx or 0,
                timed_requests=int(row.timed_requests or 0),
                avg_request_time=_optional_float(row.avg_request_time),
                max_request_time=_optional_float(row.max_request_time),
                p50_request_time=_optional_float(row.p50_request_time),
                p95_request_time=_optional_float(row.p95_request_time),
                p99_request_time=_optional_float(row.p99_request_time),
            )
            for row in result.fetchall()
        ]

    async def get_top_urls(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopUrlRow]:
        """Top URLs by hit count from raw access_logs (time-bounded).

        Raw-table scan by design: no CAGG exists for URL cardinality yet
        (future optimization; fine at homelab volume with chunk exclusion).
        """
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT
                url,
                CAST(COUNT(*) AS BIGINT) AS hits,
                CAST(COUNT(*) FILTER (WHERE status_code >= 400) AS BIGINT) AS error_hits,
                CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes,
                CAST(COUNT(request_time) AS BIGINT) AS timed_hits,
                AVG(request_time) AS avg_request_time
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND url IS NOT NULL
            {filter_sql}
            GROUP BY url
            ORDER BY hits DESC, url
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [
            TopUrlRow(
                url=row.url,
                hits=row.hits,
                error_hits=row.error_hits,
                total_bytes=row.total_bytes,
                timed_hits=row.timed_hits,
                avg_request_time=_optional_float(row.avg_request_time),
            )
            for row in result.fetchall()
        ]

    async def get_top_user_agents(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopUserAgentRow]:
        """Top user agents by hit count from raw access_logs (time-bounded)."""
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT user_agent, CAST(COUNT(*) AS BIGINT) AS hits
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND user_agent IS NOT NULL
            {filter_sql}
            GROUP BY user_agent
            ORDER BY hits DESC, user_agent
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [TopUserAgentRow(user_agent=row.user_agent, hits=row.hits) for row in result.fetchall()]

    async def get_top_asns(
        self, start: datetime, end: datetime, *, filters: AnalyticsFilters | None = None
    ) -> list[TopAsnRow]:
        """All ASNs by hit count from raw access_logs (time-bounded)."""
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT autonomous_system_number AS asn,
                   MAX(autonomous_system_organization) AS organization,
                   CAST(COUNT(*) AS BIGINT) AS hits,
                   CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end
              AND autonomous_system_number IS NOT NULL
            {filter_sql}
            GROUP BY autonomous_system_number
            ORDER BY hits DESC, asn
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, **filter_params}
        )
        return [
            TopAsnRow(
                asn=row.asn,
                organization=row.organization,
                hits=row.hits,
                total_bytes=row.total_bytes,
            )
            for row in result.fetchall()
        ]

    async def get_top_ips(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopIpRow]:
        """Top client IPs by hit count from raw access_logs (time-bounded)."""
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT
                host(ip_address) AS ip_address,
                CAST(COUNT(*) AS BIGINT) AS hits,
                CAST(COUNT(*) FILTER (WHERE status_code >= 400) AS BIGINT) AS error_hits,
                CAST(COALESCE(SUM(bytes_sent), 0) AS BIGINT) AS total_bytes,
                MAX(country_code) AS country_code,
                MAX(city) AS city
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end
            {filter_sql}
            GROUP BY ip_address
            ORDER BY hits DESC, ip_address
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [TopIpRow(**row._mapping) for row in result.fetchall()]

    async def get_top_countries(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopCountryRow]:
        """Top countries by hit count from raw access_logs (time-bounded)."""
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT
                country_code,
                MAX(country_name) AS country_name,
                CAST(COUNT(*) AS BIGINT) AS hits,
                CAST(COUNT(DISTINCT ip_address) AS BIGINT) AS unique_ips
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND country_code IS NOT NULL
            {filter_sql}
            GROUP BY country_code
            ORDER BY hits DESC, country_code
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [TopCountryRow(**row._mapping) for row in result.fetchall()]

    async def get_top_cities(
        self, start: datetime, end: datetime, limit: int = 25, *, filters: AnalyticsFilters | None = None
    ) -> list[TopCityRow]:
        """Top cities by hit count from raw access_logs (time-bounded)."""
        filter_sql, filter_params = (filters or AnalyticsFilters()).sql_conditions()
        stmt = text(f"""
            SELECT
                city,
                MAX(country_code) AS country_code,
                CAST(COUNT(*) AS BIGINT) AS hits,
                CAST(COUNT(DISTINCT ip_address) AS BIGINT) AS unique_ips
            FROM access_logs
            WHERE timestamp >= :start AND timestamp < :end AND city IS NOT NULL
            {filter_sql}
            GROUP BY city
            ORDER BY hits DESC, city
            LIMIT :limit
        """)
        result = await self.session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [TopCityRow(**row._mapping) for row in result.fetchall()]
