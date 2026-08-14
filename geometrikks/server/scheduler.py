"""APScheduler configuration for background tasks.

CAGG Refresh Strategy:
- TimescaleDB continuous aggregates are automatically refreshed by background workers
  via policies configured in timescale.py.

- The scheduler handles supplementary tasks:
  1. GeoLocation.last_hit refresh (updates regular table from hypertable data)
  2. Manual CAGG refresh for backfilling or forcing updates
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncEngine

from geometrikks.server.logging import get_logger
from geometrikks.server.timescale import ALL_CAGGS

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

logger = get_logger(__name__)


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


async def _execute_call_outside_transaction(
    session_factory: "Callable[[], AsyncSession]", sql: str, *args: object
) -> None:
    """Execute a CALL statement outside of any transaction.

    PostgreSQL CALL statements (like refresh_continuous_aggregate) cannot
    run inside a transaction block. Positional args are bound by asyncpg.
    The engine comes from the job's session factory so scheduled work runs
    against the same database the app was composed with.
    """
    session = session_factory()
    try:
        engine = session.bind
    finally:
        await session.close()
    if not isinstance(engine, AsyncEngine):
        raise RuntimeError("Session factory has no bound engine for CALL statement")
    async with engine.connect() as conn:
        raw_conn = await conn.get_raw_connection()
        driver_conn = raw_conn.driver_connection
        if driver_conn is None:
            raise RuntimeError("No driver connection available for CALL statement")
        await driver_conn.execute(sql, *args)


async def refresh_continuous_aggregate_job(
    session_factory: "Callable[[], AsyncSession]",
    cagg_name: str,
    start: datetime | None = None,
    end: datetime | None = None,
) -> None:
    """Manually refresh a TimescaleDB continuous aggregate.

    Timestamps are bound as asyncpg parameters; the CAGG name is validated
    against the ALL_CAGGS allowlist (identifiers cannot be parameters).

    Args:
        session_factory: SQLAlchemy async session factory; supplies the engine.
        cagg_name: Name of the continuous aggregate to refresh.
        start: Start of refresh window (None = beginning of time).
        end: End of refresh window (None = now).
    """
    if cagg_name not in ALL_CAGGS:
        raise ValueError(f"Unknown CAGG name: {cagg_name}")

    await _execute_call_outside_transaction(
        session_factory,
        f"CALL refresh_continuous_aggregate('{cagg_name}', $1::timestamptz, $2::timestamptz)",
        start,
        end,
    )
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
                session_factory,
                f"CALL refresh_continuous_aggregate('{cagg_name}', NULL, NULL)",
            )
            logger.info("Refreshed %s", cagg_name)
        except Exception as e:
            logger.warning("Failed to refresh %s: %s", cagg_name, e)

    logger.info("All CAGGs refresh complete")


async def create_scheduler(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
    crowdsec_poller: "CrowdSecStreamPoller | None" = None,
    mode: str = "full",
) -> AsyncIOScheduler:
    """Create and configure the APScheduler instance.

    Scheduled Jobs (mode="full"):
    - Location last_hit refresh: Every 5 minutes (configurable)
    - Full CAGG refresh: Every 6 hours (catches up any missed data)
    - GeoLite2 refresh: weekly by default
    - CrowdSec decision-stream poll, when the integration is on

    An agent instance (mode="agent") only tails logs into a schema the
    primary instance owns, so it registers just the GeoLite2 refresh: the
    other jobs are either primary-only maintenance (CAGGs, location last_hit)
    or CrowdSec, which agents never wire up.

    Note: TimescaleDB continuous aggregate policies also run in the background
    for automatic incremental refreshes. The scheduled jobs here supplement those.

    Args:
        session_factory: SQLAlchemy async session factory for creating job sessions.
        settings: Application settings for job configuration.
        mode: "full" or "agent"; controls which jobs are registered.

    Returns:
        Configured AsyncIOScheduler (not yet started).
    """
    scheduler = AsyncIOScheduler(timezone=timezone.utc)

    if not settings.scheduler.enabled:
        logger.info("Scheduler disabled via settings")
        return scheduler

    if mode != "agent":
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

    # Weekly GeoLite2 refresh (only meaningful when credentials are set;
    # ensure_geoip_database no-ops safely otherwise). Runs in every mode:
    # an agent still needs its own local GeoLite2 database kept current.
    from geometrikks.services.geoip.downloader import ensure_geoip_database

    scheduler.add_job(
        ensure_geoip_database,
        IntervalTrigger(days=settings.geoip.refresh_days),
        id="geoip-refresh",
        name="Refresh GeoLite2 database from MaxMind",
        args=[settings.geoip],
        replace_existing=True,
    )
    logger.info("Scheduled GeoLite2 refresh every %d day(s)", settings.geoip.refresh_days)

    # CrowdSec decision-stream poll: feeds live ban/unban updates to the
    # /ws/crowdsec subscribers. Only registered when the integration is on;
    # agents never receive a poller (crowdsec_lifespan no-ops for them).
    if mode != "agent" and crowdsec_poller is not None:
        scheduler.add_job(
            crowdsec_poller.poll,
            IntervalTrigger(seconds=settings.crowdsec.stream_poll_interval),
            id="crowdsec-stream-poll",
            name="Poll CrowdSec decision stream",
            max_instances=1,
            replace_existing=True,
            misfire_grace_time=10,  # seconds
        )
        logger.info(
            "Scheduled CrowdSec decision-stream poll every %.0fs",
            settings.crowdsec.stream_poll_interval,
        )

    return scheduler
