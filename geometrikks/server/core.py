from __future__ import annotations

import logging
import asyncio

from advanced_alchemy.extensions.litestar import base
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from litestar import Litestar
from litestar.di import Provide
from litestar.openapi import OpenAPIConfig

from geometrikks.config.settings import get_settings
from geometrikks.logparser.logparser import LogParser
from geometrikks.server.plugins import logging_config, parser, sqlalchemy_config, sqlalchemy_plugin
from geometrikks.api.v1.settings import read_settings
from geometrikks.api.v1.stats import stats

def provide_parser() -> LogParser:
    return parser

async def _db_available(timeout: float = 10.0) -> bool:
    """Return True if the database accepts connections; False otherwise."""
    try:
        async def _probe():
            async with sqlalchemy_config.get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
        await asyncio.wait_for(_probe(), timeout=timeout)
        return True
    except Exception as e:
        logging.getLogger(__name__).warning("Database unavailable at startup: %s", e)
        return False


async def on_startup() -> None:
    """Initialize schema if possible and start ingestion when DB is reachable.

    - If DB is unavailable, start the API in a degraded mode (no schema creation,
      no ingestion) instead of failing app startup.

    """
    if not await _db_available():
        logging.getLogger(__name__).warning(
            "Starting without database: skipping schema creation and ingestion."
        )
        return

    async with sqlalchemy_config.get_engine().begin() as conn:
        await conn.run_sync(base.DefaultBase.metadata.drop_all) # TODO remove this
        await conn.run_sync(base.DefaultBase.metadata.create_all)
    settings = get_settings()
    batch_size = settings.logparser.batch_size
    commit_interval = settings.logparser.commit_interval
    skip_validation = settings.logparser.skip_validation
    # Start async ingestion task
    ingestion_session_factory = sqlalchemy_config.create_session_maker()
    await parser.start_async(ingestion_session_factory,batch_size=batch_size, commit_interval=commit_interval, skip_validation=skip_validation)


async def on_shutdown() -> None:
    """Gracefully stop background ingestion."""
    await parser.stop_async(timeout=5.0)

def create_app() -> Litestar:
    """Create and configure the Litestar application.
    
    This factory function loads configuration and initializes the app
    with proper settings for CORS, OpenAPI, dependency injection, etc.
    
    Returns:
        Litestar: Configured application instance
    """
    # Load settings once at app creation
    settings = get_settings()

    # Configure OpenAPI
    openapi_config = OpenAPIConfig(
        title=settings.name,
        version=settings.version,
        description=settings.description,
        create_examples=True,
    )

    # Create app with configuration
    app = Litestar(
        route_handlers=[read_settings,stats],
        on_startup=[on_startup],
        on_shutdown=[on_shutdown],
        plugins=[sqlalchemy_plugin],
        dependencies={"log_parser": Provide(provide_parser, sync_to_thread=False)},
        logging_config=logging_config,
        openapi_config=openapi_config
    )

    return app