"""APScheduler configuration for background tasks."""

from __future__ import annotations

import logging
from datetime import timezone
from typing import TYPE_CHECKING, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings

logger = logging.getLogger(__name__)


async def refresh_location_last_hits_job(
    session_factory: "Callable[[], AsyncSession]",
) -> None:
    """Update GeoLocation.last_hit from actual GeoEvent timestamps.

    Creates fresh session and AggregationService for this job run.

    Args:
        session_factory: SQLAlchemy async session factory.
    """
    from geometrikks.services.aggregation.service import AggregationService

    async with session_factory() as session:
        service = AggregationService(session=session)
        updated: int = await service.refresh_location_last_hits()
        await session.commit()

        if updated > 0:
            logger.info("Refreshed last_hit for %d locations", updated)


async def create_scheduler(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
) -> AsyncIOScheduler:
    """Create and configure the APScheduler instance.

    Note: TimescaleDB continuous aggregate policies handle hourly/daily rollups
    and retention cleanup automatically. We only schedule the location refresh.

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

    # Location last_hit refresh (default: every 5 minutes)
    # This updates the regular geo_locations table with data from the geo_events hypertable
    scheduler.add_job(
        refresh_location_last_hits_job,
        IntervalTrigger(
            minutes=settings.scheduler.location_refresh_interval_minutes,
        ),
        id="location-refresh",
        name="Refresh GeoLocation.last_hit timestamps",
        args=[session_factory],
        replace_existing=True,
    )
    logger.info(
        "Scheduled location refresh every %d minute(s)",
        settings.scheduler.location_refresh_interval_minutes,
    )

    # Run initial refresh
    await refresh_location_last_hits_job(session_factory)

    return scheduler
