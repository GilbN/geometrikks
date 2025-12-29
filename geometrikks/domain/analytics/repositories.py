"""Repositories for analytics data access.

TimescaleDB continuous aggregates handle automatic aggregation:
- hourly_stats_cagg: Hourly access log metrics
- geo_events_hourly_cagg: Hourly geo event metrics
- daily_stats_cagg: Daily access log metrics

The repositories in this module query these CAGGs for fast analytics.
LiveStatsRepository queries raw hypertables for real-time data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import Sequence

from sqlalchemy import select, func, text, and_, case
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.geo.models import GeoEvent, GeoLocation
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug


class Granularity(str, Enum):
    """Time granularity for time-series queries."""

    HOURLY = "hourly"
    DAILY = "daily"


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
class HourlyStatsRow:
    """A row from the hourly_stats_cagg continuous aggregate."""

    bucket: datetime
    total_requests: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float


@dataclass
class DailyStatsRow:
    """A row from the daily_stats_cagg continuous aggregate."""

    bucket: datetime
    total_requests: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float

    @property
    def avg_bytes_per_request(self) -> float:
        """Calculate average bytes per request."""
        return self.total_bytes_sent / self.total_requests if self.total_requests > 0 else 0.0


@dataclass
class SummaryStats:
    """Summary statistics for a time period."""

    total_requests: int
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    avg_bytes_per_request: float
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float
    malformed_requests: int
    error_rate: float


class HourlyStatsRepository:
    """Repository for querying hourly_stats_cagg continuous aggregate.

    TimescaleDB automatically maintains this continuous aggregate.
    This repository provides read-only access for analytics queries.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_time_series(
        self,
        start: datetime,
        end: datetime,
    ) -> Sequence[HourlyStatsRow]:
        """Get hourly stats for a time range from the continuous aggregate.

        Args:
            start: Start datetime (will be floored to hour).
            end: End datetime (will be ceiled to hour).

        Returns:
            List of HourlyStatsRow ordered by bucket ascending.
        """
        start_hour = _floor_to_hour(start)
        end_hour = _ceil_to_hour(end)

        stmt = text("""
            SELECT
                bucket,
                total_requests,
                unique_ips,
                unique_countries,
                total_bytes_sent,
                status_2xx,
                status_3xx,
                status_4xx,
                status_5xx,
                avg_request_time,
                max_request_time
            FROM hourly_stats_cagg
            WHERE bucket >= :start AND bucket < :end
            ORDER BY bucket ASC
        """)

        result = await self.session.execute(
            stmt, {"start": start_hour, "end": end_hour}
        )
        rows = result.fetchall()

        return [
            HourlyStatsRow(
                bucket=row.bucket,
                total_requests=row.total_requests or 0,
                unique_ips=row.unique_ips or 0,
                unique_countries=row.unique_countries or 0,
                total_bytes_sent=row.total_bytes_sent or 0,
                status_2xx=row.status_2xx or 0,
                status_3xx=row.status_3xx or 0,
                status_4xx=row.status_4xx or 0,
                status_5xx=row.status_5xx or 0,
                avg_request_time=float(row.avg_request_time or 0.0),
                max_request_time=float(row.max_request_time or 0.0),
            )
            for row in rows
        ]

    async def get_summary(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get aggregated summary stats for a time range.

        Queries hourly_stats_cagg for request metrics and
        geo_events_hourly_cagg for geo-specific unique counts.

        Args:
            start: Start datetime (will be floored to hour).
            end: End datetime (will be ceiled to hour).

        Returns:
            SummaryStats with aggregated values, or None if no data.
        """
        start_hour = _floor_to_hour(start)
        end_hour = _ceil_to_hour(end)

        # Query hourly_stats_cagg for request metrics
        stmt = text("""
            SELECT
                COALESCE(SUM(total_requests), 0) AS total_requests,
                COALESCE(SUM(total_bytes_sent), 0) AS total_bytes_sent,
                COALESCE(SUM(status_2xx), 0) AS status_2xx,
                COALESCE(SUM(status_3xx), 0) AS status_3xx,
                COALESCE(SUM(status_4xx), 0) AS status_4xx,
                COALESCE(SUM(status_5xx), 0) AS status_5xx,
                COALESCE(AVG(avg_request_time), 0.0) AS avg_request_time,
                COALESCE(MAX(max_request_time), 0.0) AS max_request_time
            FROM hourly_stats_cagg
            WHERE bucket >= :start AND bucket < :end
        """)

        result = await self.session.execute(
            stmt, {"start": start_hour, "end": end_hour}
        )
        row = result.one_or_none()

        if row is None or row.total_requests == 0:
            return None

        total_requests = row.total_requests
        total_errors = row.status_4xx + row.status_5xx
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = row.total_bytes_sent / total_requests if total_requests > 0 else 0.0

        # Query geo_events_hourly_cagg for geo metrics
        geo_stmt = text("""
            SELECT
                COALESCE(SUM(total_events), 0) AS total_geo_events
            FROM geo_events_hourly_cagg
            WHERE bucket >= :start AND bucket < :end
        """)

        geo_result = await self.session.execute(
            geo_stmt, {"start": start_hour, "end": end_hour}
        )
        geo_row = geo_result.one_or_none()
        total_geo_events = geo_row.total_geo_events if geo_row else 0

        # Query raw tables for accurate unique counts (CAGGs approximate these)
        unique_counts_stmt = select(
            func.count(func.distinct(GeoEvent.ip_address)).label("unique_ips"),
            func.count(func.distinct(GeoLocation.country_code)).label("unique_countries"),
        ).select_from(
            GeoEvent
        ).join(
            GeoLocation, GeoEvent.location_id == GeoLocation.id
        ).where(
            and_(
                GeoEvent.timestamp >= start_hour,
                GeoEvent.timestamp < end_hour,
            )
        )

        unique_result = await self.session.execute(unique_counts_stmt)
        unique_row = unique_result.one_or_none()

        unique_ips = unique_row.unique_ips if unique_row else 0
        unique_countries = unique_row.unique_countries if unique_row else 0

        # Query malformed requests from debug table
        malformed_stmt = select(
            func.count().label("malformed_requests"),
        ).where(
            and_(
                AccessLogDebug.created_at >= start_hour,
                AccessLogDebug.created_at < end_hour,
                AccessLogDebug.is_malformed == True,  # noqa: E712
            )
        )

        malformed_result = await self.session.execute(malformed_stmt)
        malformed_row = malformed_result.one_or_none()
        malformed_requests = malformed_row.malformed_requests if malformed_row else 0

        return SummaryStats(
            total_requests=total_requests,
            total_geo_events=total_geo_events,
            unique_ips=unique_ips,
            unique_countries=unique_countries,
            total_bytes_sent=row.total_bytes_sent,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx,
            status_3xx=row.status_3xx,
            status_4xx=row.status_4xx,
            status_5xx=row.status_5xx,
            avg_request_time=float(row.avg_request_time),
            max_request_time=float(row.max_request_time),
            malformed_requests=malformed_requests,
            error_rate=error_rate,
        )


class DailyStatsRepository:
    """Repository for querying daily_stats_cagg continuous aggregate.

    TimescaleDB automatically maintains this continuous aggregate.
    This repository provides read-only access for analytics queries.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_time_series(
        self,
        start_date: date,
        end_date: date,
    ) -> Sequence[DailyStatsRow]:
        """Get daily stats for a date range from the continuous aggregate.

        Args:
            start_date: Start date (inclusive).
            end_date: End date (inclusive).

        Returns:
            List of DailyStatsRow ordered by bucket ascending.
        """
        # Convert dates to timestamps for the query
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        stmt = text("""
            SELECT
                bucket,
                total_requests,
                unique_ips,
                unique_countries,
                total_bytes_sent,
                status_2xx,
                status_3xx,
                status_4xx,
                status_5xx,
                avg_request_time,
                max_request_time
            FROM daily_stats_cagg
            WHERE bucket >= :start AND bucket <= :end
            ORDER BY bucket ASC
        """)

        result = await self.session.execute(
            stmt, {"start": start_dt, "end": end_dt}
        )
        rows = result.fetchall()

        return [
            DailyStatsRow(
                bucket=row.bucket,
                total_requests=row.total_requests or 0,
                unique_ips=row.unique_ips or 0,
                unique_countries=row.unique_countries or 0,
                total_bytes_sent=row.total_bytes_sent or 0,
                status_2xx=row.status_2xx or 0,
                status_3xx=row.status_3xx or 0,
                status_4xx=row.status_4xx or 0,
                status_5xx=row.status_5xx or 0,
                avg_request_time=float(row.avg_request_time or 0.0),
                max_request_time=float(row.max_request_time or 0.0),
            )
            for row in rows
        ]

    async def get_summary(
        self,
        start_date: date,
        end_date: date,
    ) -> SummaryStats | None:
        """Get aggregated summary stats for a date range.

        Args:
            start_date: Start date (inclusive).
            end_date: End date (inclusive).

        Returns:
            SummaryStats with aggregated values, or None if no data.
        """
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        stmt = text("""
            SELECT
                COALESCE(SUM(total_requests), 0) AS total_requests,
                COALESCE(SUM(total_bytes_sent), 0) AS total_bytes_sent,
                COALESCE(SUM(status_2xx), 0) AS status_2xx,
                COALESCE(SUM(status_3xx), 0) AS status_3xx,
                COALESCE(SUM(status_4xx), 0) AS status_4xx,
                COALESCE(SUM(status_5xx), 0) AS status_5xx,
                COALESCE(AVG(avg_request_time), 0.0) AS avg_request_time,
                COALESCE(MAX(max_request_time), 0.0) AS max_request_time
            FROM daily_stats_cagg
            WHERE bucket >= :start AND bucket <= :end
        """)

        result = await self.session.execute(
            stmt, {"start": start_dt, "end": end_dt}
        )
        row = result.one_or_none()

        if row is None or row.total_requests == 0:
            return None

        # Query geo_events_hourly_cagg for geo metrics
        geo_stmt = text("""
            SELECT
                COALESCE(SUM(total_events), 0) AS total_geo_events,
                COALESCE(SUM(unique_ips), 0) AS unique_ips,
                COALESCE(SUM(unique_countries), 0) AS unique_countries
            FROM geo_events_hourly_cagg
            WHERE bucket >= :start AND bucket < :end
        """)

        geo_result = await self.session.execute(
            geo_stmt, {"start": start_dt, "end": end_dt}
        )
        geo_row = geo_result.one_or_none()
        total_geo_events = geo_row.total_geo_events if geo_row else 0
        unique_ips = geo_row.unique_ips if geo_row else 0
        unique_countries = geo_row.unique_countries if geo_row else 0

        # Query malformed requests from debug table
        malformed_stmt = select(
            func.count().label("malformed_requests"),
        ).where(
            and_(
                AccessLogDebug.created_at >= start_dt,
                AccessLogDebug.created_at < end_dt,
                AccessLogDebug.is_malformed == True,  # noqa: E712
            )
        )

        malformed_result = await self.session.execute(malformed_stmt)
        malformed_row = malformed_result.one_or_none()
        malformed_requests = malformed_row.malformed_requests if malformed_row else 0


        total_requests = row.total_requests
        total_errors = row.status_4xx + row.status_5xx
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = row.total_bytes_sent / total_requests if total_requests > 0 else 0.0

        # For daily summaries, we don't query unique counts from raw tables
        # as it would be too expensive. Use approximations from the CAGG.
        return SummaryStats(
            total_requests=total_requests,
            total_geo_events=total_geo_events,
            unique_ips=unique_ips,
            unique_countries=unique_countries,
            total_bytes_sent=row.total_bytes_sent,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx,
            status_3xx=row.status_3xx,
            status_4xx=row.status_4xx,
            status_5xx=row.status_5xx,
            avg_request_time=float(row.avg_request_time),
            max_request_time=float(row.max_request_time),
            malformed_requests=malformed_requests,
            error_rate=error_rate,
        )


class LiveStatsRepository:
    """Repository for querying live statistics directly from raw hypertables.

    Queries AccessLog, GeoEvent, and AccessLogDebug directly instead of
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

        Unlike HourlyStatsRepository.get_summary which uses continuous
        aggregates, this queries the raw tables directly for real-time
        accuracy.

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            SummaryStats with live values, or None if no data.
        """

        # Query GeoEvent first - this is the primary data source
        geo_events_stmt = select(
            func.count().label("total_geo_events"),
            func.count(func.distinct(GeoEvent.ip_address)).label("unique_ips"),
            func.count(func.distinct(GeoLocation.country_code)).label("unique_countries"),
        ).select_from(
            GeoEvent
        ).join(
            GeoLocation, GeoEvent.location_id == GeoLocation.id
        ).where(
            and_(
                GeoEvent.timestamp >= start,
                GeoEvent.timestamp < end,
            )
        )

        geo_result = await self.session.execute(geo_events_stmt)
        geo_row = geo_result.one_or_none()

        total_geo_events = geo_row.total_geo_events if geo_row else 0
        unique_ips = geo_row.unique_ips if geo_row else 0
        unique_countries = geo_row.unique_countries if geo_row else 0

        # Query AccessLog for request metrics
        access_log_stmt = select(
            func.count().label("total_requests"),
            func.coalesce(func.sum(AccessLog.bytes_sent), 0).label("total_bytes_sent"),
            func.sum(
                case(
                    (and_(AccessLog.status_code >= 200, AccessLog.status_code < 300), 1),
                    else_=0
                )
            ).label("status_2xx"),
            func.sum(
                case(
                    (and_(AccessLog.status_code >= 300, AccessLog.status_code < 400), 1),
                    else_=0
                )
            ).label("status_3xx"),
            func.sum(
                case(
                    (and_(AccessLog.status_code >= 400, AccessLog.status_code < 500), 1),
                    else_=0
                )
            ).label("status_4xx"),
            func.sum(
                case(
                    (and_(AccessLog.status_code >= 500, AccessLog.status_code < 600), 1),
                    else_=0
                )
            ).label("status_5xx"),
            func.coalesce(func.avg(AccessLog.request_time), 0.0).label("avg_request_time"),
            func.coalesce(func.max(AccessLog.request_time), 0.0).label("max_request_time"),
        ).where(
            and_(
                AccessLog.timestamp >= start,
                AccessLog.timestamp < end,
            )
        )

        access_result = await self.session.execute(access_log_stmt)
        access_row = access_result.one_or_none()

        # Query AccessLogDebug for malformed requests count
        malformed_stmt = select(
            func.count().label("malformed_requests"),
        ).where(
            and_(
                AccessLogDebug.created_at >= start,
                AccessLogDebug.created_at < end,
                AccessLogDebug.is_malformed == True,  # noqa: E712
            )
        )

        malformed_result = await self.session.execute(malformed_stmt)
        malformed_row = malformed_result.one_or_none()
        malformed_requests = malformed_row.malformed_requests if malformed_row else 0

        # Return None only if both GeoEvent and AccessLog have no data
        total_requests = access_row.total_requests if access_row else 0
        if total_geo_events == 0 and total_requests == 0:
            return None

        # Calculate derived values
        total_errors = ((access_row.status_4xx or 0) + (access_row.status_5xx or 0)) if access_row else 0
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = (access_row.total_bytes_sent or 0) / total_requests if total_requests > 0 else 0.0

        return SummaryStats(
            total_requests=total_requests,
            total_geo_events=total_geo_events,
            unique_ips=unique_ips,
            unique_countries=unique_countries,
            total_bytes_sent=access_row.total_bytes_sent if access_row else 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=access_row.status_2xx if access_row else 0,
            status_3xx=access_row.status_3xx if access_row else 0,
            status_4xx=access_row.status_4xx if access_row else 0,
            status_5xx=access_row.status_5xx if access_row else 0,
            avg_request_time=float(access_row.avg_request_time or 0.0) if access_row else 0.0,
            max_request_time=float(access_row.max_request_time or 0.0) if access_row else 0.0,
            malformed_requests=malformed_requests,
            error_rate=error_rate,
        )
