"""APScheduler configuration and scheduled job definitions.

This module configures the AsyncIOScheduler from APScheduler 3.x and defines
scheduled tasks for analytics aggregation.

Jobs create their own database sessions to avoid shared state issues.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings

logger = logging.getLogger(__name__)


async def daily_rollup_job(
    session_factory: "Callable[[], AsyncSession]",
    retention_days: int,
) -> None:
    """Compute daily rollup for yesterday's data and cleanup old hourly stats.

    Creates fresh repositories and AggregationService instance for this job run.

    Args:
        session_factory: SQLAlchemy async session factory.
        retention_days: Number of days to retain hourly stats.
    """
    from geometrikks.domain.analytics.repositories import (
        HourlyStatsRepository,
        DailyStatsRepository,
    )
    from geometrikks.services.aggregation.service import AggregationService

    async with session_factory() as session:
        hourly_repo = HourlyStatsRepository(session=session)
        daily_repo = DailyStatsRepository(session=session)

        service = AggregationService(
            hourly_stats_repo=hourly_repo,
            daily_stats_repo=daily_repo,
            hourly_retention_days=retention_days,
        )

        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()
        await service.compute_daily_rollup(yesterday)
        await service.cleanup_old_hourly_stats()
        await session.commit()

        logger.info("Completed daily rollup job for %s", yesterday)


async def refresh_location_last_hits_job(
    session_factory: "Callable[[], AsyncSession]",
) -> None:
    """Update GeoLocation.last_hit from actual GeoEvent timestamps.

    Creates fresh repositories and AggregationService instance for this job run.

    Args:
        session_factory: SQLAlchemy async session factory.
    """
    from geometrikks.domain.analytics.repositories import (
        HourlyStatsRepository,
        DailyStatsRepository,
    )
    from geometrikks.services.aggregation.service import AggregationService

    async with session_factory() as session:
        hourly_repo = HourlyStatsRepository(session=session)
        daily_repo = DailyStatsRepository(session=session)

        service = AggregationService(
            hourly_stats_repo=hourly_repo,
            daily_stats_repo=daily_repo,
        )

        updated: int = await service.refresh_location_last_hits()
        await session.commit()

        logger.info("Refreshed last_hit for %d locations", updated)


def create_scheduler(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
) -> AsyncIOScheduler:
    """Create and configure the APScheduler instance.

    Args:
        session_factory: SQLAlchemy async session factory for creating job sessions.
        settings: Application settings for job configuration.

    Returns:
        Configured AsyncIOScheduler (not yet started).
    """
    scheduler = AsyncIOScheduler(timezone=timezone.utc)

    if not settings.scheduler.enabled:
        logger.info("Scheduler disabled via settings")
        return scheduler

    # Daily rollup at configured time (default: 00:05 UTC)
    scheduler.add_job(
        daily_rollup_job,
        CronTrigger(
            hour=settings.scheduler.daily_rollup_hour,
            minute=settings.scheduler.daily_rollup_minute,
            timezone=timezone.utc,
        ),
        id="daily-rollup",
        name="Daily stats rollup and cleanup",
        args=[session_factory, settings.analytics.hourly_retention_days],
        replace_existing=True,
    )
    logger.info(
        "Scheduled daily rollup at %02d:%02d UTC",
        settings.scheduler.daily_rollup_hour,
        settings.scheduler.daily_rollup_minute,
    )

    # Location last_hit refresh (default: every hour)
    scheduler.add_job(
        refresh_location_last_hits_job,
        IntervalTrigger(
            hours=settings.scheduler.location_refresh_interval_hours,
        ),
        id="location-refresh",
        name="Refresh GeoLocation.last_hit timestamps",
        args=[session_factory],
        replace_existing=True,
    )
    logger.info(
        "Scheduled location refresh every %d hour(s)",
        settings.scheduler.location_refresh_interval_hours,
    )

    return scheduler
