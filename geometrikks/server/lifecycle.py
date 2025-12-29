"""Application lifecycle hooks for startup and shutdown.

TimescaleDB Setup:
- Hypertables are created for time-series tables (geo_events, access_logs, access_log_debug)
- Continuous aggregates provide fast pre-computed analytics
- Retention and compression policies are automatically managed
"""

from __future__ import annotations

import logging
import asyncio
from typing import TYPE_CHECKING, Callable

from advanced_alchemy.extensions.litestar import base
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from geometrikks.config.settings import get_settings, AnalyticsSettings
from geometrikks.server.plugins import parser, sqlalchemy_config

from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.server.scheduler import create_scheduler

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


async def _setup_timescaledb(analytics: AnalyticsSettings) -> None:
    """Set up TimescaleDB hypertables, continuous aggregates, and policies.

    This function is idempotent - safe to call on every startup.
    It creates hypertables, continuous aggregates, and policies if they don't exist.
    """
    async with sqlalchemy_config.get_engine().begin() as conn:
        # Enable TimescaleDB extension
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE"))
        logger.info("TimescaleDB extension enabled")

        # Convert tables to hypertables
        # TimescaleDB requires the time column to be part of any unique/primary key.
        # We drop the PK constraint, create hypertable, then re-add a composite PK.
        hypertables = [
            ("geo_events", "timestamp", "1 day", "pk_geo_events"),
            ("access_logs", "timestamp", "1 day", "pk_access_logs"),
            ("access_log_debug", "created_at", "1 week", "pk_access_log_debug"),
        ]

        for table, time_col, chunk_interval, pk_name in hypertables:
            try:
                # Check if already a hypertable
                result = await conn.execute(text(f"""
                    SELECT 1 FROM timescaledb_information.hypertables
                    WHERE hypertable_name = '{table}'
                """))
                if result.scalar():
                    logger.info("Hypertable already exists: %s", table)
                    continue

                # Drop the existing primary key constraint
                await conn.execute(text(f"""
                    ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {pk_name}
                """))

                # Create hypertable
                await conn.execute(text(f"""
                    SELECT create_hypertable(
                        '{table}',
                        '{time_col}',
                        chunk_time_interval => INTERVAL '{chunk_interval}',
                        if_not_exists => TRUE,
                        migrate_data => TRUE
                    )
                """))

                # Add composite primary key with time column
                await conn.execute(text(f"""
                    ALTER TABLE {table} ADD CONSTRAINT {pk_name} PRIMARY KEY (id, {time_col})
                """))

                logger.info("Hypertable created: %s (chunk: %s)", table, chunk_interval)
            except Exception as e:
                logger.exception("Hypertable %s setup failed: %s", table, e)
                raise

        # Create continuous aggregates for analytics
        # Hourly stats aggregate from access_logs
        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_stats_cagg
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 hour', timestamp) AS bucket,
                COUNT(*) AS total_requests,
                COUNT(DISTINCT ip_address) AS unique_ips,
                COUNT(DISTINCT country_code) AS unique_countries,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes_sent,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time
            FROM access_logs
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: hourly_stats_cagg")

        # Geo events hourly aggregate
        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS geo_events_hourly_cagg
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 hour', timestamp) AS bucket,
                COUNT(*) AS total_events,
                COUNT(DISTINCT ip_address) AS unique_ips,
                COUNT(DISTINCT location_id) AS unique_locations
            FROM geo_events
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: geo_events_hourly_cagg")

        # Daily stats aggregate (rolls up from hourly)
        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats_cagg
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 day', timestamp) AS bucket,
                COUNT(*) AS total_requests,
                COUNT(DISTINCT ip_address) AS unique_ips,
                COUNT(DISTINCT country_code) AS unique_countries,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes_sent,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time
            FROM access_logs
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: daily_stats_cagg")

        # Add refresh policies for continuous aggregates
        refresh_interval = f"{analytics.cagg_refresh_interval_minutes} minutes"

        # Helper to add refresh policy (idempotent via ON CONFLICT)
        for cagg, start_offset, end_offset in [
            ("hourly_stats_cagg", "3 hours", "1 hour"),
            ("geo_events_hourly_cagg", "3 hours", "1 hour"),
            ("daily_stats_cagg", "3 days", "1 day"),
        ]:
            try:
                await conn.execute(text(f"""
                    SELECT add_continuous_aggregate_policy(
                        '{cagg}',
                        start_offset => INTERVAL '{start_offset}',
                        end_offset => INTERVAL '{end_offset}',
                        schedule_interval => INTERVAL '{refresh_interval}',
                        if_not_exists => TRUE
                    )
                """))
                logger.info("Refresh policy added/verified: %s (every %s)", cagg, refresh_interval)
            except Exception as e:
                logger.debug("Refresh policy for %s: %s", cagg, e)

        # Add retention policies for hypertables
        retention_configs = [
            ("geo_events", analytics.raw_retention_days),
            ("access_logs", analytics.raw_retention_days),
            ("access_log_debug", analytics.debug_retention_days),
        ]

        for table, days in retention_configs:
            try:
                await conn.execute(text(f"""
                    SELECT add_retention_policy(
                        '{table}',
                        drop_after => INTERVAL '{days} days',
                        if_not_exists => TRUE
                    )
                """))
                logger.info("Retention policy added/verified: %s (%d days)", table, days)
            except Exception as e:
                logger.debug("Retention policy for %s: %s", table, e)

        # Add retention policy for hourly CAGG
        try:
            await conn.execute(text(f"""
                SELECT add_retention_policy(
                    'hourly_stats_cagg',
                    drop_after => INTERVAL '{analytics.hourly_retention_days} days',
                    if_not_exists => TRUE
                )
            """))
            logger.info(
                "Retention policy added/verified: hourly_stats_cagg (%d days)",
                analytics.hourly_retention_days,
            )
        except Exception as e:
            logger.debug("Retention policy for hourly_stats_cagg: %s", e)

        # Add compression policies for hypertables
        compression_days = analytics.compression_after_days

        for table in ["geo_events", "access_logs", "access_log_debug"]:
            try:
                # Enable compression on the hypertable
                await conn.execute(text(f"""
                    ALTER TABLE {table} SET (
                        timescaledb.compress,
                        timescaledb.compress_segmentby = ''
                    )
                """))
                # Add compression policy
                await conn.execute(text(f"""
                    SELECT add_compression_policy(
                        '{table}',
                        compress_after => INTERVAL '{compression_days} days',
                        if_not_exists => TRUE
                    )
                """))
                logger.info(
                    "Compression policy added/verified: %s (after %d days)",
                    table,
                    compression_days,
                )
            except Exception as e:
                logger.debug("Compression policy for %s: %s", table, e)

        logger.info("TimescaleDB setup complete")


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

    async with sqlalchemy_config.get_engine().begin() as conn:
        # Enable PostGIS extension (required for geography type)
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        logger.info("PostGIS extension enabled")

        if settings.database.drop_on_startup:
            logger.warning("Dropping all tables on startup as per configuration.")
            await conn.run_sync(base.DefaultBase.metadata.drop_all)
        await conn.run_sync(base.DefaultBase.metadata.create_all)

    # Set up TimescaleDB hypertables, continuous aggregates, and policies
    await _setup_timescaledb(settings.analytics)

    # Dedicated session for the ingestion service
    session_maker: Callable[[], AsyncSession] = sqlalchemy_config.create_session_maker()
    ingestion_session: AsyncSession = session_maker()

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
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
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
    app.state.ingestion_session: AsyncSession = ingestion_session
    app.state.scheduler: AsyncIOScheduler = scheduler

    # Start ingestion service
    await ingestion_service.start(
        skip_validation=settings.logparser.skip_validation,
    )


async def on_shutdown(app: "Litestar") -> None:
    """Gracefully stop background services and clean up resources."""
    #from apscheduler.schedulers.asyncio import AsyncIOScheduler

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

    # Close the shared session
    ingestion_session = getattr(app.state, "ingestion_session", None)
    if ingestion_session:
        await ingestion_session.close()
        logger.info("Closed ingestion session")
