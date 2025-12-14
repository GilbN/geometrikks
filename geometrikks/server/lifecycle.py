"""Application lifecycle hooks for startup and shutdown."""

from __future__ import annotations

import logging
import asyncio
from typing import TYPE_CHECKING

from advanced_alchemy.extensions.litestar import base
from sqlalchemy import text

from geometrikks.config.settings import get_settings
from geometrikks.server.plugins import parser, sqlalchemy_config

from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository
from geometrikks.services.ingestion import LogIngestionService

if TYPE_CHECKING:
    from litestar import Litestar

logger = logging.getLogger(__name__)


async def _db_available(timeout: float = 10.0) -> bool:
    """Return True if the database accepts connections; False otherwise."""
    try:
        async def _probe():
            async with sqlalchemy_config.get_engine().connect() as conn:
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
    """
    if not await _db_available():
        logger.warning("Starting without database: skipping schema creation and ingestion.")
        return

    settings = get_settings()
    
    async with sqlalchemy_config.get_engine().begin() as conn:
        if settings.database.drop_on_startup:
            logger.warning("Dropping all tables on startup as per configuration.")
            await conn.run_sync(base.DefaultBase.metadata.drop_all)
        await conn.run_sync(base.DefaultBase.metadata.create_all)


    # Dedicated session for the ingestion service
    session_maker = sqlalchemy_config.create_session_maker()
    ingestion_session = session_maker()

    geo_location_repo = GeoLocationRepository(session=ingestion_session)
    geo_event_repo = GeoEventRepository(session=ingestion_session)
    access_log_repo = AccessLogRepository(session=ingestion_session)
    access_log_debug_repo = AccessLogDebugRepository(session=ingestion_session)

    ingestion_service = LogIngestionService(
        parser=parser,
        geo_location_repo=geo_location_repo,
        geo_event_repo=geo_event_repo,
        access_log_repo=access_log_repo,
        access_log_debug_repo=access_log_debug_repo,
        batch_size=settings.logparser.batch_size,
        commit_interval=settings.logparser.commit_interval,
        store_debug_lines=settings.logparser.store_debug_lines,
    )

    # Store in app state for shutdown and API access
    app.state.ingestion_service = ingestion_service
    app.state.ingestion_session = ingestion_session

    await ingestion_service.start(
        skip_validation=settings.logparser.skip_validation,
    )


async def on_shutdown(app: "Litestar") -> None:
    """Gracefully stop background ingestion and clean up resources."""

    ingestion_service: LogIngestionService | None = getattr(
        app.state, "ingestion_service", None
    )
    if ingestion_service:
        await ingestion_service.stop(timeout=5.0)

    ingestion_session = getattr(app.state, "ingestion_session", None)
    if ingestion_session:
        await ingestion_session.close()
        logger.info("Closed ingestion session")
