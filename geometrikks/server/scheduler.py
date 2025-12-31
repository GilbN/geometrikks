"""APScheduler configuration for background tasks.

CAGG Refresh Strategy:
- TimescaleDB continuous aggregates are automatically refreshed by background workers
  via policies configured in timescale.py.

- The scheduler handles supplementary tasks:
  1. GeoLocation.last_hit refresh (updates regular table from hypertable data)
  2. Manual CAGG refresh for backfilling or forcing updates
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from geometrikks.server.plugins import sqlalchemy_config
from geometrikks.server.timescale import ALL_CAGGS

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings

logger = logging.getLogger(__name__)


# =============================================================================
# Refresh Functions - Can be called manually or scheduled
# =============================================================================


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


async def _execute_call_outside_transaction(sql: str) -> None:
    """Execute a CALL statement outside of any transaction.

    PostgreSQL CALL statements (like refresh_continuous_aggregate) cannot
    run inside a transaction block. This helper gets a raw connection and
    executes the CALL with autocommit semantics.

    Args:
        sql: The CALL SQL statement to execute.
    """
    engine = sqlalchemy_config.get_engine()
    # Get raw asyncpg connection to bypass SQLAlchemy transaction handling
    async with engine.connect() as conn:
        raw_conn = await conn.get_raw_connection()
        # asyncpg connection - execute directly
        await raw_conn.driver_connection.execute(sql)


async def refresh_continuous_aggregate_job(
    session_factory: "Callable[[], AsyncSession]",
    cagg_name: str,
    start: datetime | None = None,
    end: datetime | None = None,
) -> None:
    """Manually refresh a TimescaleDB continuous aggregate.

    Useful for backfilling historical data or forcing an immediate refresh.
    If start/end are None, refreshes all data.

    Note: CALL statements must run outside transactions. This function
    uses a raw connection to bypass SQLAlchemy's transaction handling.

    Args:
        session_factory: SQLAlchemy async session factory (unused but kept for API consistency).
        cagg_name: Name of the continuous aggregate to refresh.
        start: Start of refresh window (None = beginning of time).
        end: End of refresh window (None = now).
    """
    if start is None and end is None:
        sql = f"CALL refresh_continuous_aggregate('{cagg_name}', NULL, NULL)"
    else:
        # Format timestamps for SQL
        start_str = f"'{start.isoformat()}'" if start else "NULL"
        end_str = f"'{end.isoformat()}'" if end else "NULL"
        sql = f"CALL refresh_continuous_aggregate('{cagg_name}', {start_str}::timestamptz, {end_str}::timestamptz)"

    await _execute_call_outside_transaction(sql)
    logger.info("Refreshed continuous aggregate: %s", cagg_name)


async def refresh_all_caggs_job(
    session_factory: "Callable[[], AsyncSession]",
) -> None:
    """Refresh all continuous aggregates.

    Useful for catching up any data that might have been missed or
    after bulk data imports.

    Note: CALL statements must run outside transactions.

    Args:
        session_factory: SQLAlchemy async session factory.
    """
    for cagg_name in ALL_CAGGS:
        try:
            await _execute_call_outside_transaction(
                f"CALL refresh_continuous_aggregate('{cagg_name}', NULL, NULL)"
            )
            logger.info("Refreshed %s", cagg_name)
        except Exception as e:
            logger.warning("Failed to refresh %s: %s", cagg_name, e)

    logger.info("All CAGGs refresh complete")


async def create_scheduler(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
) -> AsyncIOScheduler:
    """Create and configure the APScheduler instance.

    Scheduled Jobs:
    - Location last_hit refresh: Every 5 minutes (configurable)
    - Full CAGG refresh: Every 6 hours (catches up any missed data)

    Note: TimescaleDB continuous aggregate policies also run in the background
    for automatic incremental refreshes. The scheduled jobs here supplement those.

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

    # Full CAGG refresh (every 6 hours)
    # This ensures all continuous aggregates are in sync
    # Useful for catching up any data that might have been missed
    scheduler.add_job(
        refresh_all_caggs_job,
        IntervalTrigger(hours=6),
        id="cagg-full-refresh",
        name="Full refresh of all CAGGs",
        args=[session_factory],
        replace_existing=True,
    )
    logger.info("Scheduled full CAGG refresh every 6 hours")

    return scheduler
