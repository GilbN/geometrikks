"""Application lifecycle hooks for startup and shutdown."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Callable

from advanced_alchemy.extensions.litestar import base
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from geometrikks.config.settings import get_settings
from geometrikks.server.plugins import get_sqlalchemy_config
from geometrikks.server.timescale import setup_timescaledb, teardown_timescaledb

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
    """Initialize schema if possible and start ingestion when DB is reachable.

    - If DB is unavailable, start the API in a degraded mode (no schema creation,
      no ingestion) instead of failing app startup.
    - Sets up TimescaleDB hypertables and continuous aggregates after table creation.
    """
    if not await _db_available():
        logger.warning("Starting without database: skipping schema creation and ingestion.")
        return

    settings = get_settings()
    engine = get_sqlalchemy_config().get_engine()

    # Create schema
    async with engine.begin() as conn:
        # Enable PostGIS extension (required for geography type)
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        logger.info("PostGIS extension enabled")

        if settings.database.drop_on_startup:
            logger.warning("Dropping all tables on startup as per configuration.")
            await teardown_timescaledb(conn)
            await conn.run_sync(base.DefaultBase.metadata.drop_all)
        await conn.run_sync(base.DefaultBase.metadata.create_all)

    # Set up TimescaleDB (hypertables, CAGGs, policies)
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
