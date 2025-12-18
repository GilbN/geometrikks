"""Aggregation service for computing and storing analytics stats.

This service handles:
- Real-time increments of hourly stats during log ingestion
- Daily rollup computation from hourly stats (called by APScheduler)
- Retention cleanup for old hourly stats (called by APScheduler)
- GeoLocation.last_hit refresh (called by APScheduler)
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import text
from geometrikks.domain.analytics.repositories import BatchMetrics

if TYPE_CHECKING:
    from geometrikks.domain.analytics.repositories import (
        HourlyStatsRepository,
        DailyStatsRepository,
    )

logger = logging.getLogger(__name__)


class AggregationService:
    """Service for aggregating analytics statistics.

    Provides aggregation methods called by:
    1. LogIngestionService during batch commits (increment_hourly_stats)
    2. APScheduler jobs (compute_daily_rollup, cleanup_old_hourly_stats, etc.)

    Example:
        service = AggregationService(
            hourly_stats_repo=hourly_repo,
            daily_stats_repo=daily_repo,
            hourly_retention_days=30,
        )
        # Called by LogIngestionService:
        await service.increment_hourly_stats(metrics)
        # Called by scheduled jobs:
        await service.compute_daily_rollup(yesterday)
    """

    def __init__(
        self,
        hourly_stats_repo: "HourlyStatsRepository",
        daily_stats_repo: "DailyStatsRepository",
        *,
        hourly_retention_days: int = 30,
    ) -> None:
        """Initialize the aggregation service.

        Args:
            hourly_stats_repo: Repository for HourlyStats model.
            daily_stats_repo: Repository for DailyStats model.
            hourly_retention_days: Days to keep hourly stats before cleanup.
        """
        self.hourly_stats_repo = hourly_stats_repo
        self.daily_stats_repo = daily_stats_repo
        self.hourly_retention_days = hourly_retention_days

        # Statistics
        self.total_increments: int = 0
        self.total_rollups: int = 0
        self.last_rollup_date: date | None = None

    async def increment_hourly_stats(self, metrics: BatchMetrics) -> None:
        """Increment hourly stats with batch metrics.

        This method is called from LogIngestionService during batch commits.
        It atomically updates the hourly stats for the given hour.

        Note: GeoLocation.last_hit is updated periodically via refresh_location_last_hits()
        by the scheduled job, not per-batch, to ensure accuracy.

        Args:
            metrics: BatchMetrics containing the incremental values.
        """
        try:
            await self.hourly_stats_repo.upsert_increment(metrics)
            self.total_increments += 1
        except Exception as e:
            logger.exception("Failed to increment hourly stats: %s", e)
            # Don't re-raise - we don't want to fail the ingestion

    async def refresh_location_last_hits(self) -> int:
        """Update GeoLocation.last_hit from actual GeoEvent timestamps.

        This derives the accurate last_hit timestamp by finding MAX(timestamp)
        from geo_events for each location. Only updates locations where the
        computed max is greater than the current last_hit (or last_hit is NULL).

        Returns:
            Number of locations updated.
        """
        try:
            # Use raw SQL for efficient bulk update with subquery
            stmt = text("""
                UPDATE geo_locations gl
                SET last_hit = subq.max_ts
                FROM (
                    SELECT location_id, MAX(timestamp) as max_ts
                    FROM geo_events
                    GROUP BY location_id
                ) subq
                WHERE gl.id = subq.location_id
                  AND (gl.last_hit IS NULL OR gl.last_hit < subq.max_ts)
            """)
            result = await self.hourly_stats_repo.session.execute(stmt)
            updated = result.rowcount or 0
            if updated > 0:
                logger.info("Refreshed last_hit for %d locations", updated)
            return updated
        except Exception as e:
            logger.exception("Failed to refresh location last_hits: %s", e)
            return 0

    async def compute_daily_rollup(self, target_date: date) -> bool:
        """Compute daily stats from hourly data for a specific date.

        Args:
            target_date: The date to compute daily stats for.

        Returns:
            True if rollup was successful, False otherwise.
        """
        try:
            result = await self.daily_stats_repo.upsert_from_hourly(target_date)
            if result:
                self.total_rollups += 1
                self.last_rollup_date = target_date
                logger.info(
                    "Computed daily rollup for %s: %d requests",
                    target_date,
                    result.total_requests,
                )
                return True
            else:
                logger.debug("No hourly data for %s, skipping rollup", target_date)
                return False
        except Exception as e:
            logger.exception("Failed to compute daily rollup for %s: %s", target_date, e)
            return False

    async def cleanup_old_hourly_stats(self) -> int:
        """Delete hourly stats older than retention period.

        Returns:
            Number of deleted records.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.hourly_retention_days)
        try:
            deleted = await self.hourly_stats_repo.delete_before(cutoff)
            if deleted > 0:
                logger.info(
                    "Cleaned up %d hourly stats older than %s",
                    deleted,
                    cutoff.date(),
                )
            return deleted
        except Exception as e:
            logger.exception("Failed to cleanup old hourly stats: %s", e)
            return 0

    async def backfill_daily_stats(
        self,
        start_date: date,
        end_date: date,
    ) -> int:
        """Backfill daily stats from hourly data for a date range.

        Useful for catching up after system downtime or initial setup.

        Args:
            start_date: First date to backfill (inclusive).
            end_date: Last date to backfill (inclusive).

        Returns:
            Number of days successfully backfilled.
        """
        success_count = 0
        current = start_date

        while current <= end_date:
            if await self.compute_daily_rollup(current):
                success_count += 1
            current += timedelta(days=1)

        # Commit all changes
        try:
            await self.daily_stats_repo.session.commit()
        except Exception as e:
            logger.exception("Failed to commit backfill: %s", e)

        logger.info(
            "Backfilled %d days of daily stats from %s to %s",
            success_count,
            start_date,
            end_date,
        )
        return success_count
