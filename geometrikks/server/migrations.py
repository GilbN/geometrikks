"""Programmatic alembic migrations for app startup.

Import-time safe: nothing here constructs settings or an engine at import
time — everything happens inside the functions.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from advanced_alchemy.alembic.commands import AlembicCommands
from advanced_alchemy.config import AlembicAsyncConfig, SQLAlchemyAsyncConfig
from advanced_alchemy.extensions.litestar import base
from sqlalchemy import text

from geometrikks.config.settings import get_settings
from geometrikks.server.logging import get_logger
from geometrikks.server.timescale import teardown_timescaledb

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from geometrikks.config.settings import Settings

logger = get_logger(__name__)


def upgrade_to_head() -> None:
    """Run ``alembic upgrade head`` synchronously; call via asyncio.to_thread().

    Builds a dedicated migration config from the settings URL instead of
    reusing get_sqlalchemy_config(): alembic's env.py starts its own event
    loop (asyncio.run), and sharing the app engine would let connections
    bound to that throwaway loop land back in the app's pool.
    """
    config = SQLAlchemyAsyncConfig(
        connection_string=get_settings().database.url,
        alembic_config=AlembicAsyncConfig(
            script_config="alembic.ini",
            script_location="migrations",
        ),
    )
    AlembicCommands(config).upgrade(revision="head")
    logger.info("Database schema migrated to head")


async def migrate_database(engine: AsyncEngine, settings: Settings) -> None:
    """Apply the drop-on-startup gate, then upgrade the schema to head.

    drop_on_startup is only honored in the development environment; anywhere
    else it is refused with an error log and startup continues normally.
    A failed upgrade raises and is expected to fail app startup.
    """
    if settings.database.drop_on_startup:
        if settings.environment == "development":
            logger.warning(
                "drop_on_startup enabled: dropping ALL tables and timescale "
                "objects (development environment)."
            )
            async with engine.begin() as conn:
                await teardown_timescaledb(conn)
                await conn.run_sync(base.DefaultBase.metadata.drop_all)
                await conn.execute(text("DROP TABLE IF EXISTS alembic_versions"))
        else:
            logger.error(
                "drop_on_startup ignored: environment is %r (only honored in "
                "development).",
                settings.environment,
            )
    await asyncio.to_thread(upgrade_to_head)
