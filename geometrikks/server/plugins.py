from __future__ import annotations

from litestar.logging import LoggingConfig
from litestar.serialization import decode_json, encode_json
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from advanced_alchemy.extensions.litestar import (
    AsyncSessionConfig,
    SQLAlchemyAsyncConfig,
    SQLAlchemyInitPlugin,
    base
)

from litestar_geoalchemy import GeoAlchemyPlugin

from geometrikks.services.logparser import LogParser
from geometrikks.config.settings import get_settings

settings = get_settings()

parser = LogParser(
    log_path=settings.logparser.log_path,
    geoip_path=settings.geoip.db_path,
    geoip_locales=settings.geoip.locales,
    send_logs=settings.logparser.send_logs,
    host_name=settings.logparser.host_name,
    store_debug_lines=settings.logparser.store_debug_lines,
)

_engine = create_async_engine(
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

sqlalchemy_config = SQLAlchemyAsyncConfig(
    engine_instance=_engine,
    session_config=AsyncSessionConfig(expire_on_commit=False),
    create_all=False,
    metadata=base.DefaultBase.metadata,
)

sqlalchemy_plugin = SQLAlchemyInitPlugin(config=sqlalchemy_config)

logging_config = LoggingConfig(
    root={"level": "DEBUG", "handlers": ["queue_listener"]},
    formatters={
        "standard": {"format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s"}
    },
    log_exceptions="always",
)

geoalchemy_plugin = GeoAlchemyPlugin()