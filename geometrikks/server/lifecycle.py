"""Application lifecycle hooks for startup and shutdown."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from geometrikks.config.settings import get_settings
from geometrikks.server.migrations import migrate_database
from geometrikks.server.plugins import get_sqlalchemy_config
from geometrikks.server.timescale import setup_timescaledb

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.server.scheduler import create_scheduler

if TYPE_CHECKING:
    from litestar import Litestar

logger = logging.getLogger(__name__)


async def _db_available(timeout: float = 10.0) -> bool:
    """Return True if the database accepts connections; False otherwise."""
    try:
        async def _probe():
            async with get_sqlalchemy_config().get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(_probe(), timeout=timeout)
        return True
    except Exception as e:
        logger.warning("Database unavailable at startup: %s", e)
        return False


async def on_startup(app: "Litestar") -> None:
    """Run alembic migrations and start ingestion when DB is reachable.

    - If DB is unavailable, start the API in a degraded mode (no migrations,
      no ingestion) instead of failing app startup.
    - If the DB is reachable but the migration fails, that failure propagates
      and fails startup deliberately: a reachable DB with a broken schema is
      an error to surface, not an outage to degrade around.
    - Sets up TimescaleDB hypertables and continuous aggregates after migrations.
    """
    if not await _db_available():
        logger.warning("Starting without database: skipping migrations and ingestion.")
        return

    settings = get_settings()
    engine = get_sqlalchemy_config().get_engine()

    # Schema is owned by alembic (migrations/versions). A failed upgrade
    # raises and fails startup deliberately: a reachable DB with a broken
    # schema is an error to surface, not an outage to degrade around.
    await migrate_database(engine, settings)

    # TimescaleDB objects (hypertables, CAGGs, policies) deliberately stay
    # out of alembic: the DDL is idempotent, timescale-version-sensitive,
    # and alembic autogenerate can neither model nor diff them.
    await setup_timescaledb(engine, settings.analytics)

    # Session factory: ingestion opens a short-lived session per batch flush
    session_maker: Callable[[], AsyncSession] = get_sqlalchemy_config().create_session_maker()

    parsers = [
        LogParser(
            log_path=path,
            send_logs=settings.logparser.send_logs,
            poll_interval=settings.logparser.poll_interval,
            hostname=settings.logparser.host_name,
        )
        for path in settings.logparser.log_paths
    ]

    ingestion_service = LogIngestionService(
        parsers=parsers,
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        hostname=settings.logparser.host_name,
        batch_size=settings.logparser.batch_size,
        commit_interval=settings.logparser.commit_interval,
        store_debug_lines=settings.logparser.store_debug_lines,
    )

    # Create and start scheduler
    scheduler: AsyncIOScheduler = await create_scheduler(session_maker, settings)
    scheduler.start()
    logger.info("Started APScheduler")

    # Store in app state for shutdown and API access
    app.state.ingestion_service: LogIngestionService = ingestion_service
    app.state.scheduler: AsyncIOScheduler = scheduler

    # Start ingestion service
    await ingestion_service.start(
        skip_validation=settings.logparser.skip_validation,
    )


async def on_shutdown(app: "Litestar") -> None:
    """Gracefully stop background services and clean up resources."""
    # Stop ingestion service first
    ingestion_service: LogIngestionService | None = getattr(
        app.state, "ingestion_service", None
    )
    if ingestion_service:
        await ingestion_service.stop(timeout=5.0)

    # Stop scheduler
    scheduler: AsyncIOScheduler | None = getattr(app.state, "scheduler", None)
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=True)
        logger.info("Stopped APScheduler")
