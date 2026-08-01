"""Factory functions for plugin instances and configurations.

Nothing in this module is constructed at import time — settings (and therefore
engine, vite config, and logging config) are only built when a factory is
called from create_app() or the lifecycle hooks. This keeps imports working
when e.g. the GeoIP database is missing.
"""

from __future__ import annotations
import platform
import shutil
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from litestar.middleware.logging import LoggingMiddlewareConfig
from litestar.plugins.structlog import StructlogConfig, StructlogPlugin
from litestar.serialization import decode_json, encode_json
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from advanced_alchemy.extensions.litestar import (
    AsyncSessionConfig,
    SQLAlchemyAsyncConfig,
    SQLAlchemyInitPlugin,
    base,
)

from litestar.plugins import CLIPlugin
from litestar_geoalchemy import GeoAlchemyPlugin
from litestar_granian import GranianPlugin
from litestar_vite import ViteConfig, VitePlugin
from litestar_vite.config import RuntimeConfig, TypeGenConfig, PathConfig

from geometrikks.config.settings import get_settings, Settings
from geometrikks.server.logging import create_logging_config

if TYPE_CHECKING:
    from litestar import Litestar


def create_sqlalchemy_config(settings: Settings) -> SQLAlchemyAsyncConfig:
    """Build an async engine and SQLAlchemy config from explicit settings."""
    engine = create_async_engine(
        url=settings.database.url,
        echo=settings.database.echo,
        pool_size=settings.database.pool_size,
        max_overflow=settings.database.max_overflow,
        pool_timeout=settings.database.pool_timeout,
        pool_recycle=settings.database.pool_recycle,
        future=True,
        json_serializer=encode_json,
        json_deserializer=decode_json,
        echo_pool=settings.database.echo_pool,
        pool_pre_ping=settings.database.pool_pre_ping,
        pool_use_lifo=True,  # use lifo to reduce the number of idle connections
        poolclass=NullPool if settings.database.pool_disabled else None,
    )
    return SQLAlchemyAsyncConfig(
        engine_instance=engine,
        session_config=AsyncSessionConfig(expire_on_commit=False),
        create_all=False,
        metadata=base.DefaultBase.metadata,
    )


@lru_cache(maxsize=1)
def get_sqlalchemy_config() -> SQLAlchemyAsyncConfig:
    """Process-cached engine/config from ambient settings.

    For contexts with no composed app (the import-logs CLI, hand-built test
    apps). App code paths should resolve the app-bound config through
    get_app_db_config() so create_app(settings=...) governs the database.
    """
    return create_sqlalchemy_config(get_settings())


def get_app_db_config(app: Litestar) -> SQLAlchemyAsyncConfig:
    """The SQLAlchemy config the app was composed with.

    create_app() stores its config on app.state; the fallback keeps
    hand-built test apps (which never went through create_app) working
    against the process-cached config.
    """
    config = getattr(app.state, "db_config", None)
    return config if config is not None else get_sqlalchemy_config()


def create_vite_config(settings: Settings) -> ViteConfig:
    return ViteConfig(
        mode="spa",
        runtime=RuntimeConfig(
            dev_mode=settings.vite.dev_mode,
            http2=settings.vite.http2,
            host=settings.vite.host,
            port=settings.vite.port,
            executor=settings.vite.executor,
            start_dev_server=settings.vite.use_server_lifespan,
            is_react=settings.vite.enable_react_helpers,
            # litestar-vite 0.25 executor bug on Windows: it compares run_command[0]
            # against shutil.which("bun") case-sensitively ("bun" vs "bun.EXE"), fails,
            # and prepends the binary — running `bun.EXE bun run dev` (bun's legacy
            # bundler). Using the same which() result as the command head sidesteps it.
            run_command=(
                [shutil.which("bun") or "bun", "run", "dev"]
                if platform.system() == "Windows"
                else None
            ),
        ),
        types=TypeGenConfig(
            output=Path("resources/generated"),
            generate_zod=True,
            generate_sdk=True,
            generate_routes=True,
            generate_page_props=True,
        ),
        paths=PathConfig(
            resource_dir=Path("resources"),
            bundle_dir=Path("public"),
        ),
    )


def create_structlog_plugin(settings: Settings) -> StructlogPlugin:
    """Structlog pipeline + structured request logging middleware."""
    return StructlogPlugin(
        config=StructlogConfig(
            structlog_logging_config=create_logging_config(settings),
            middleware_logging_config=LoggingMiddlewareConfig(
                response_log_fields=("status_code",),
                request_log_fields=("path", "method", "query", "path_params"),
            ),
        )
    )


def create_plugins(
    settings: Settings | None = None,
    db_config: SQLAlchemyAsyncConfig | None = None,
) -> list[
    SQLAlchemyInitPlugin | GeoAlchemyPlugin | GranianPlugin | VitePlugin | CLIPlugin | StructlogPlugin
]:
    """Instantiate all app plugins; called once from create_app()."""
    from geometrikks.cli import ImportLogsCLIPlugin

    if db_config is None:
        # Explicit settings must also govern the SQLAlchemy plugin; only a
        # fully ambient call may use the process-cached config.
        db_config = get_sqlalchemy_config() if settings is None else create_sqlalchemy_config(settings)
    if settings is None:
        settings = get_settings()
    return [
        SQLAlchemyInitPlugin(config=db_config),
        GeoAlchemyPlugin(),  # GeoAlchemy plugin for PostGIS support
        GranianPlugin(),
        VitePlugin(config=create_vite_config(settings)),
        ImportLogsCLIPlugin(),
        create_structlog_plugin(settings),
    ]
