"""Repositories for analytics data access."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import Sequence

from sqlalchemy import select, func, text, and_, case
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.analytics.models import HourlyStats, DailyStats
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
class TimeSeriesPoint:
    """A single point in a time-series."""

    timestamp: datetime
    total_requests: int
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float
    malformed_requests: int


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


@dataclass
class BatchMetrics:
    """Metrics collected from a single batch commit.

    Used to increment hourly stats during log ingestion.
    """

    timestamp: datetime
    requests: int = 0
    geo_events: int = 0
    bytes_sent: int = 0
    status_2xx: int = 0
    status_3xx: int = 0
    status_4xx: int = 0
    status_5xx: int = 0
    total_request_time: float = 0.0
    max_request_time: float = 0.0
    malformed_requests: int = 0
    unique_ips: set[str] | None = None
    unique_countries: set[str] | None = None
    
    def get_hour_timestamp(self) -> datetime:
        """Get the timestamp truncated to the hour."""
        hour: datetime = self.timestamp.replace(minute=0, second=0, microsecond=0)
        if hour.tzinfo is None:
            hour = hour.replace(tzinfo=timezone.utc)
        return hour
    
    def is_after_truncated_hour(self, other: datetime) -> bool:
        """Check if the given datetime is after the batch's hour timestamp."""
        other_hour: datetime = other.replace(minute=0, second=0, microsecond=0)
        if other_hour.tzinfo is None:
            other_hour = other_hour.replace(tzinfo=timezone.utc)
        return other_hour > self.get_hour_timestamp()
    
    def update_truncated_hour(self, new_timestamp: datetime) -> None:
        """Update the batch's timestamp to the new truncated hour"""
        new_hour: datetime = new_timestamp.replace(minute=0, second=0, microsecond=0)
        if new_hour.tzinfo is None:
            new_hour = new_hour.replace(tzinfo=timezone.utc)
        self.timestamp = new_hour


class HourlyStatsRepository(SQLAlchemyAsyncRepository[HourlyStats]):
    """Repository for HourlyStats model with real-time aggregation support."""

    model_type = HourlyStats

    async def upsert_increment(self, metrics: BatchMetrics) -> None:
        """Atomically increment hourly stats for a given hour.

        Uses PostgreSQL INSERT ... ON CONFLICT DO UPDATE for atomic upserts.
        This method is called during LogIngestionService batch commits.

        Args:
            metrics: BatchMetrics containing the incremental values to add.
        """
        # Truncate timestamp to hour
        hour = metrics.timestamp.replace(minute=0, second=0, microsecond=0)
        if hour.tzinfo is None:
            hour = hour.replace(tzinfo=timezone.utc)

        # Calculate average request time for this batch
        avg_time = (
            metrics.total_request_time / metrics.requests
            if metrics.requests > 0
            else 0.0
        )

        # Use raw SQL for the upsert with proper aggregation
        # unique_ips and unique_countries are approximated by adding batch counts
        # For exact counts, we'd need HyperLogLog or similar
        stmt = insert(HourlyStats).values(
            hour=hour,
            total_requests=metrics.requests,
            total_geo_events=metrics.geo_events,
            unique_ips=len(metrics.unique_ips) if metrics.unique_ips else 0,
            unique_countries=len(metrics.unique_countries)
            if metrics.unique_countries
            else 0,
            total_bytes_sent=metrics.bytes_sent,
            status_2xx=metrics.status_2xx,
            status_3xx=metrics.status_3xx,
            status_4xx=metrics.status_4xx,
            status_5xx=metrics.status_5xx,
            avg_request_time=avg_time,
            max_request_time=metrics.max_request_time,
            malformed_requests=metrics.malformed_requests,
        )

        # On conflict, increment values and update max/avg
        stmt = stmt.on_conflict_do_update(
            constraint="uq_hourly_stats_hour",
            set_={
                "total_requests": HourlyStats.total_requests + metrics.requests,
                "total_geo_events": HourlyStats.total_geo_events + metrics.geo_events,
                # For unique counts, we add the batch count (approximation)
                # A more accurate approach would use HyperLogLog
                "unique_ips": HourlyStats.unique_ips
                + (len(metrics.unique_ips) if metrics.unique_ips else 0),
                "unique_countries": HourlyStats.unique_countries
                + (len(metrics.unique_countries) if metrics.unique_countries else 0),
                "total_bytes_sent": HourlyStats.total_bytes_sent + metrics.bytes_sent,
                "status_2xx": HourlyStats.status_2xx + metrics.status_2xx,
                "status_3xx": HourlyStats.status_3xx + metrics.status_3xx,
                "status_4xx": HourlyStats.status_4xx + metrics.status_4xx,
                "status_5xx": HourlyStats.status_5xx + metrics.status_5xx,
                # For avg, we use weighted average formula:
                # new_avg = (old_avg * old_count + new_sum) / (old_count + new_count)
                "avg_request_time": func.coalesce(
                    (
                        HourlyStats.avg_request_time * HourlyStats.total_requests
                        + metrics.total_request_time
                    )
                    / func.nullif(HourlyStats.total_requests + metrics.requests, 0),
                    0.0
                ),
                "max_request_time": func.greatest(
                    HourlyStats.max_request_time, metrics.max_request_time
                ),
                "malformed_requests": HourlyStats.malformed_requests
                + metrics.malformed_requests,
            },
        )

        await self.session.execute(stmt)

    async def get_time_series(
        self,
        start: datetime,
        end: datetime,
    ) -> Sequence[HourlyStats]:
        """Get hourly stats for a time range.

        Timestamps are aligned to hour boundaries:
        - Start is floored to the hour
        - End is ceiled to the next hour
        - Query uses [start, end) range

        Args:
            start: Start datetime (will be floored to hour).
            end: End datetime (will be ceiled to hour).

        Returns:
            List of HourlyStats ordered by hour ascending.
        """
        start_hour = _floor_to_hour(start)
        end_hour = _ceil_to_hour(end)

        stmt = (
            select(HourlyStats)
            .where(
                and_(
                    HourlyStats.hour >= start_hour,
                    HourlyStats.hour < end_hour,
                )
            )
            .order_by(HourlyStats.hour.asc())
        )
        result = await self.session.execute(stmt)
        return result.scalars().all()

    async def get_summary(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get aggregated summary stats for a time range.

        Timestamps are aligned to hour boundaries since HourlyStats uses hourly buckets:
        - Start is floored to the hour (10:30 -> 10:00)
        - End is ceiled to the next hour (11:30 -> 12:00)
        - Query uses [start, end) range (inclusive start, exclusive end)

        Unique IP and country counts are queried directly from GeoEvent
        for accuracy instead of using approximated sums from HourlyStats.

        Args:
            start: Start datetime (will be floored to hour).
            end: End datetime (will be ceiled to hour).

        Returns:
            SummaryStats with aggregated values, or None if no data.
        """
        # Align to hour boundaries for HourlyStats bucket precision
        start_hour = _floor_to_hour(start)
        end_hour = _ceil_to_hour(end)

        # Query HourlyStats with hour-aligned boundaries using [start, end) range
        stmt = select(
            func.sum(HourlyStats.total_requests).label("total_requests"),
            func.sum(HourlyStats.total_geo_events).label("total_geo_events"),
            func.sum(HourlyStats.total_bytes_sent).label("total_bytes_sent"),
            func.sum(HourlyStats.status_2xx).label("status_2xx"),
            func.sum(HourlyStats.status_3xx).label("status_3xx"),
            func.sum(HourlyStats.status_4xx).label("status_4xx"),
            func.sum(HourlyStats.status_5xx).label("status_5xx"),
            func.avg(HourlyStats.avg_request_time).label("avg_request_time"),
            func.max(HourlyStats.max_request_time).label("max_request_time"),
            func.sum(HourlyStats.malformed_requests).label("malformed_requests"),
        ).where(
            and_(
                HourlyStats.hour >= start_hour,
                HourlyStats.hour < end_hour,
            )
        )

        result = await self.session.execute(stmt)
        row = result.one_or_none()

        if row is None or row.total_requests is None:
            return None

        total_requests = row.total_requests or 0
        total_errors = (row.status_4xx or 0) + (row.status_5xx or 0)
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = (
            (row.total_bytes_sent or 0) / total_requests if total_requests > 0 else 0.0
        )

        # Query GeoEvent directly for accurate unique counts
        # This avoids the approximation error from summing per-hour unique counts
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

        return SummaryStats(
            total_requests=total_requests,
            total_geo_events=row.total_geo_events or 0,
            unique_ips=unique_ips,
            unique_countries=unique_countries,
            total_bytes_sent=row.total_bytes_sent or 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx or 0,
            status_3xx=row.status_3xx or 0,
            status_4xx=row.status_4xx or 0,
            status_5xx=row.status_5xx or 0,
            avg_request_time=row.avg_request_time or 0.0,
            max_request_time=row.max_request_time or 0.0,
            malformed_requests=row.malformed_requests or 0,
            error_rate=error_rate,
        )

    async def delete_before(self, cutoff: datetime) -> int:
        """Delete hourly stats older than cutoff date.

        Used for retention cleanup (default: 30 days).

        Args:
            cutoff: Delete records with hour before this datetime.

        Returns:
            Number of deleted records.
        """
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)

        stmt = text(
            "DELETE FROM hourly_stats WHERE hour < :cutoff"
        )
        result = await self.session.execute(stmt, {"cutoff": cutoff})
        return result.rowcount


class DailyStatsRepository(SQLAlchemyAsyncRepository[DailyStats]):
    """Repository for DailyStats model with rollup support."""

    model_type = DailyStats

    async def upsert_from_hourly(self, target_date: date) -> DailyStats | None:
        """Compute and upsert daily stats from hourly data.

        Rolls up all hourly stats for a given date into a single daily record.

        Args:
            target_date: The date to compute daily stats for.

        Returns:
            The created/updated DailyStats record, or None if no hourly data.
        """
        # Get start and end of day in UTC
        start = datetime(
            target_date.year, target_date.month, target_date.day, 0, 0, 0, tzinfo=timezone.utc
        )
        end = datetime(
            target_date.year, target_date.month, target_date.day, 23, 59, 59, tzinfo=timezone.utc
        )

        # Aggregate hourly stats for the day
        stmt = select(
            func.sum(HourlyStats.total_requests).label("total_requests"),
            func.sum(HourlyStats.total_geo_events).label("total_geo_events"),
            func.sum(HourlyStats.unique_ips).label("unique_ips"),
            func.max(HourlyStats.unique_countries).label("unique_countries"),
            func.sum(HourlyStats.total_bytes_sent).label("total_bytes_sent"),
            func.sum(HourlyStats.status_2xx).label("status_2xx"),
            func.sum(HourlyStats.status_3xx).label("status_3xx"),
            func.sum(HourlyStats.status_4xx).label("status_4xx"),
            func.sum(HourlyStats.status_5xx).label("status_5xx"),
            func.avg(HourlyStats.avg_request_time).label("avg_request_time"),
            func.max(HourlyStats.max_request_time).label("max_request_time"),
            func.sum(HourlyStats.malformed_requests).label("malformed_requests"),
        ).where(HourlyStats.hour.between(start, end))

        result = await self.session.execute(stmt)
        row = result.one_or_none()

        if row is None or row.total_requests is None or row.total_requests == 0:
            return None

        # Find peak hour
        peak_stmt = (
            select(
                func.extract("hour", HourlyStats.hour).label("hour_of_day"),
                HourlyStats.total_requests,
            )
            .where(HourlyStats.hour.between(start, end))
            .order_by(HourlyStats.total_requests.desc())
            .limit(1)
        )
        peak_result = await self.session.execute(peak_stmt)
        peak_row = peak_result.one_or_none()

        peak_hour = int(peak_row.hour_of_day) if peak_row else 0
        peak_hour_requests = peak_row.total_requests if peak_row else 0

        total_requests = row.total_requests or 0
        avg_bytes = (
            (row.total_bytes_sent or 0) / total_requests if total_requests > 0 else 0.0
        )

        # Upsert daily stats
        stmt = insert(DailyStats).values(
            date=target_date,
            total_requests=total_requests,
            total_geo_events=row.total_geo_events or 0,
            unique_ips=row.unique_ips or 0,
            unique_countries=row.unique_countries or 0,
            total_bytes_sent=row.total_bytes_sent or 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx or 0,
            status_3xx=row.status_3xx or 0,
            status_4xx=row.status_4xx or 0,
            status_5xx=row.status_5xx or 0,
            avg_request_time=row.avg_request_time or 0.0,
            max_request_time=row.max_request_time or 0.0,
            peak_hour_requests=peak_hour_requests,
            peak_hour=peak_hour,
            malformed_requests=row.malformed_requests or 0,
        )

        stmt = stmt.on_conflict_do_update(
            constraint="uq_daily_stats_date",
            set_={
                "total_requests": total_requests,
                "total_geo_events": row.total_geo_events or 0,
                "unique_ips": row.unique_ips or 0,
                "unique_countries": row.unique_countries or 0,
                "total_bytes_sent": row.total_bytes_sent or 0,
                "avg_bytes_per_request": avg_bytes,
                "status_2xx": row.status_2xx or 0,
                "status_3xx": row.status_3xx or 0,
                "status_4xx": row.status_4xx or 0,
                "status_5xx": row.status_5xx or 0,
                "avg_request_time": row.avg_request_time or 0.0,
                "max_request_time": row.max_request_time or 0.0,
                "peak_hour_requests": peak_hour_requests,
                "peak_hour": peak_hour,
                "malformed_requests": row.malformed_requests or 0,
            },
        )

        await self.session.execute(stmt)

        # Return the upserted record
        return await self.get_one_or_none(date=target_date)

    async def get_time_series(
        self,
        start_date: date,
        end_date: date,
    ) -> Sequence[DailyStats]:
        """Get daily stats for a date range.

        Args:
            start_date: Start date (inclusive).
            end_date: End date (inclusive).

        Returns:
            List of DailyStats ordered by date ascending.
        """
        stmt = (
            select(DailyStats)
            .where(DailyStats.date.between(start_date, end_date))
            .order_by(DailyStats.date.asc())
        )
        result = await self.session.execute(stmt)
        return result.scalars().all()

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
        stmt = select(
            func.sum(DailyStats.total_requests).label("total_requests"),
            func.sum(DailyStats.total_geo_events).label("total_geo_events"),
            func.sum(DailyStats.unique_ips).label("unique_ips"),
            func.max(DailyStats.unique_countries).label("unique_countries"),
            func.sum(DailyStats.total_bytes_sent).label("total_bytes_sent"),
            func.sum(DailyStats.status_2xx).label("status_2xx"),
            func.sum(DailyStats.status_3xx).label("status_3xx"),
            func.sum(DailyStats.status_4xx).label("status_4xx"),
            func.sum(DailyStats.status_5xx).label("status_5xx"),
            func.avg(DailyStats.avg_request_time).label("avg_request_time"),
            func.max(DailyStats.max_request_time).label("max_request_time"),
            func.sum(DailyStats.malformed_requests).label("malformed_requests"),
        ).where(DailyStats.date.between(start_date, end_date))

        result = await self.session.execute(stmt)
        row = result.one_or_none()

        if row is None or row.total_requests is None:
            return None

        total_requests = row.total_requests or 0
        total_errors = (row.status_4xx or 0) + (row.status_5xx or 0)
        error_rate = total_errors / total_requests if total_requests > 0 else 0.0
        avg_bytes = (
            (row.total_bytes_sent or 0) / total_requests if total_requests > 0 else 0.0
        )

        return SummaryStats(
            total_requests=total_requests,
            total_geo_events=row.total_geo_events or 0,
            unique_ips=row.unique_ips or 0,
            unique_countries=row.unique_countries or 0,
            total_bytes_sent=row.total_bytes_sent or 0,
            avg_bytes_per_request=avg_bytes,
            status_2xx=row.status_2xx or 0,
            status_3xx=row.status_3xx or 0,
            status_4xx=row.status_4xx or 0,
            status_5xx=row.status_5xx or 0,
            avg_request_time=row.avg_request_time or 0.0,
            max_request_time=row.max_request_time or 0.0,
            malformed_requests=row.malformed_requests or 0,
            error_rate=error_rate,
        )


class LiveStatsRepository:
    """Repository for querying live statistics directly from raw tables.

    Queries AccessLog, GeoEvent, and AccessLogDebug directly instead of
    using pre-aggregated hourly buckets.

    This repository does NOT extend SQLAlchemyAsyncRepository since it
    performs custom aggregate queries across multiple tables rather than
    CRUD operations on a single model.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_summary(
        self,
        start: datetime,
        end: datetime,
    ) -> SummaryStats | None:
        """Get live summary stats

        Unlike HourlyStatsRepository.get_summary which uses pre-aggregated
        hourly buckets, this queries AccessLog, GeoEvent, and AccessLogDebug
        directly for real-time accuracy.

        Note: AccessLog data is optional (controlled by LOGPARSER_SEND_LOGS).
        GeoEvent is the primary data source, so we check that first.

        Args:
            start: Start datetime.
            end: End datetime.

        Returns:
            SummaryStats with live values, or None if no data.
        """

        # Query GeoEvent first - this is the primary data source
        # AccessLog is optional (LOGPARSER_SEND_LOGS setting)
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

        # Query AccessLog for request metrics (optional - may be empty)
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
