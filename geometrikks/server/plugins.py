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

from litestar.logging import LoggingConfig
from litestar.serialization import decode_json, encode_json
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from advanced_alchemy.extensions.litestar import (
    AsyncSessionConfig,
    SQLAlchemyAsyncConfig,
    SQLAlchemyInitPlugin,
    base,
)

from litestar_geoalchemy import GeoAlchemyPlugin
from litestar_granian import GranianPlugin
from litestar_vite import ViteConfig, VitePlugin
from litestar_vite.config import RuntimeConfig, TypeGenConfig, PathConfig

from geometrikks.config.settings import get_settings, Settings


@lru_cache(maxsize=1)
def get_sqlalchemy_config() -> SQLAlchemyAsyncConfig:
    """Build (once per process) the async engine and SQLAlchemy config."""
    settings = get_settings()
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
        pool_pre_ping=True,
        pool_use_lifo=True,  # use lifo to reduce the number of idle connections
        poolclass=NullPool if settings.database.pool_disabled else None,
    )
    return SQLAlchemyAsyncConfig(
        engine_instance=engine,
        session_config=AsyncSessionConfig(expire_on_commit=False),
        create_all=False,
        metadata=base.DefaultBase.metadata,
    )


def create_vite_config(settings: Settings) -> ViteConfig:
    return ViteConfig(
        mode="spa",
        runtime=RuntimeConfig(
            dev_mode=settings.vite.dev_mode,
            http2=settings.vite.http2,
            host=settings.vite.host,
            port=settings.vite.port,
            executor=settings.vite.executor,
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


def create_logging_config(settings: Settings) -> LoggingConfig:
    return LoggingConfig(
        root={"level": settings.api.log_level, "handlers": ["queue_listener"]},
        formatters={
            "standard": {"format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s"}
        },
        log_exceptions="always",
    )


def create_plugins() -> list[SQLAlchemyInitPlugin | GeoAlchemyPlugin | GranianPlugin | VitePlugin]:
    """Instantiate all app plugins; called once from create_app()."""
    settings = get_settings()
    return [
        SQLAlchemyInitPlugin(config=get_sqlalchemy_config()),
        GeoAlchemyPlugin(),  # GeoAlchemy plugin for PostGIS support
        GranianPlugin(),
        VitePlugin(config=create_vite_config(settings)),
    ]
