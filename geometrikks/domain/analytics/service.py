"""Aggregation service for computing and storing analytics stats.

This service handles:
- Real-time increments of hourly stats during log ingestion
- Daily rollup computation from hourly stats
- Retention cleanup for old hourly stats
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import update
from geometrikks.domain.analytics.repositories import BatchMetrics
from geometrikks.domain.geo.models import GeoLocation

if TYPE_CHECKING:
    from geometrikks.domain.analytics.repositories import (
        HourlyStatsRepository,
        DailyStatsRepository,
    )

logger = logging.getLogger(__name__)


class AggregationService:
    """Service for aggregating analytics statistics.

    Provides two main functions:
    1. Real-time increments: Called during LogIngestionService batch commits
       to update hourly stats atomically.
    2. Daily rollups: Background task that computes daily stats from hourly
       data at midnight.

    Example:
        service = AggregationService(
            hourly_stats_repo=hourly_repo,
            daily_stats_repo=daily_repo,
            hourly_retention_days=30,
        )
        await service.start()
        # ... during ingestion ...
        await service.increment_hourly_stats(metrics)
        # ... later ...
        await service.stop()
    """

    def __init__(
        self,
        hourly_stats_repo: "HourlyStatsRepository",
        daily_stats_repo: "DailyStatsRepository",
        *,
        hourly_retention_days: int = 30,
        enable_daily_rollup: bool = True,
    ) -> None:
        """Initialize the aggregation service.

        Args:
            hourly_stats_repo: Repository for HourlyStats model.
            daily_stats_repo: Repository for DailyStats model.
            hourly_retention_days: Days to keep hourly stats before cleanup.
            enable_daily_rollup: If True, run daily rollup background task.
        """
        self.hourly_stats_repo = hourly_stats_repo
        self.daily_stats_repo = daily_stats_repo
        self.hourly_retention_days = hourly_retention_days
        self.enable_daily_rollup = enable_daily_rollup

        # Background task management
        self._stop_event: asyncio.Event | None = None
        self._rollup_task: asyncio.Task[None] | None = None

        # Statistics
        self.total_increments: int = 0
        self.total_rollups: int = 0
        self.last_rollup_date: date | None = None

    @property
    def is_running(self) -> bool:
        """Return True if the rollup background task is running."""
        return self._rollup_task is not None and not self._rollup_task.done()

    async def start(self) -> None:
        """Start the daily rollup background task."""
        if not self.enable_daily_rollup:
            logger.info("Daily rollup disabled, skipping background task start")
            return

        if self.is_running:
            logger.warning("Aggregation service already running")
            return

        self._stop_event = asyncio.Event()
        self._rollup_task = asyncio.create_task(
            self._run_daily_rollup_loop(),
            name="daily-rollup",
        )
        logger.info(
            "Started aggregation service (hourly_retention=%d days)",
            self.hourly_retention_days,
        )

    async def stop(self, timeout: float = 10.0) -> None:
        """Stop the aggregation service gracefully.

        Args:
            timeout: Seconds to wait before force-cancelling.
        """
        if not self._stop_event or not self._rollup_task:
            return

        self._stop_event.set()
        try:
            await asyncio.wait_for(self._rollup_task, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Rollup task did not stop gracefully, cancelling")
            self._rollup_task.cancel()
            try:
                await self._rollup_task
            except asyncio.CancelledError:
                pass
        except asyncio.CancelledError:
            pass

        logger.info(
            "Stopped aggregation service. Total rollups: %d", self.total_rollups
        )

    async def increment_hourly_stats(self, metrics: BatchMetrics) -> None:
        """Increment hourly stats with batch metrics.

        This method is called from LogIngestionService during batch commits.
        It atomically updates the hourly stats for the given hour and updates
        the last_hit timestamps for accessed locations.

        Args:
            metrics: BatchMetrics containing the incremental values.
        """
        try:
            await self.hourly_stats_repo.upsert_increment(metrics)
            self.total_increments += 1

            # Update last_hit for locations accessed in this batch
            if metrics.location_ids:
                await self._update_location_last_hit(metrics.timestamp, metrics.location_ids)
        except Exception as e:
            logger.exception("Failed to increment hourly stats: %s", e)
            # Don't re-raise - we don't want to fail the ingestion

    async def _update_location_last_hit(
        self, timestamp: datetime, location_ids: set[int]
    ) -> None:
        """Update last_hit timestamp for accessed locations.

        Args:
            timestamp: The timestamp to set for last_hit.
            location_ids: Set of location IDs to update.
        """
        if not location_ids:
            return

        try:
            stmt = update(GeoLocation).where(
                GeoLocation.id.in_(location_ids)
            ).values(last_hit=timestamp)

            await self.hourly_stats_repo.session.execute(stmt)
        except Exception as e:
            logger.exception("Failed to update location last_hit: %s", e)
            # Don't re-raise - this is a non-critical operation

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

    async def _run_daily_rollup_loop(self) -> None:
        """Background task that runs daily rollup at midnight UTC."""
        logger.info("Daily rollup loop started")

        try:
            while not self._stop_event or not self._stop_event.is_set():
                now = datetime.now(timezone.utc)

                # Calculate seconds until next midnight UTC
                next_midnight = (now + timedelta(days=1)).replace(
                    hour=0, minute=5, second=0, microsecond=0
                )  # Run at 00:05 to ensure all data is in
                sleep_seconds = (next_midnight - now).total_seconds()

                # Wait until midnight or stop event
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait() if self._stop_event else asyncio.sleep(sleep_seconds),
                        timeout=sleep_seconds,
                    )
                    # If we get here without timeout, stop_event was set
                    break
                except asyncio.TimeoutError:
                    # Timeout means it's time to run the rollup
                    pass

                # Compute rollup for yesterday
                yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()
                await self.compute_daily_rollup(yesterday)

                # Cleanup old hourly stats
                await self.cleanup_old_hourly_stats()

                # Commit the changes
                try:
                    await self.hourly_stats_repo.session.commit()
                except Exception as e:
                    logger.exception("Failed to commit after rollup: %s", e)

        except asyncio.CancelledError:
            logger.info("Daily rollup loop cancelled")
            raise
        except Exception as e:
            logger.exception("Daily rollup loop error: %s", e)
            raise

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
