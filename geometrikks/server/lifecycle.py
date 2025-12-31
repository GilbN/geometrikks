"""Application lifecycle hooks for startup and shutdown.

TimescaleDB Setup:
- Hypertables are created for time-series tables (geo_events, access_logs, access_log_debug)
- Continuous aggregates provide fast pre-computed analytics
- HyperLogLog sketches enable fast approximate unique counts across any time range
- Retention and compression policies are automatically managed

CAGG Structure:
- summary_hourly_stats / summary_daily_stats: Access log metrics (requests, bytes, status codes, latency)
- geo_summary_hourly_stats / geo_summary_daily_stats: Geo metrics with HLL (events, unique IPs/countries/cities)
- location_hourly_stats / location_daily_stats: Location event counts for map
- ip_location_daily_stats: Per-IP counts by location for top IPs feature
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
        # Enable TimescaleDB extension and toolkit (for HyperLogLog)
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit CASCADE"))
        logger.info("TimescaleDB and toolkit extensions enabled")

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

        # =====================================================================
        # SUMMARY STATS CAGGs (from access_logs)
        # For: Summary page, Analytics charts
        # =====================================================================

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS summary_hourly_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 hour', timestamp) AS bucket,
                COUNT(*) AS total_requests,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time) AS p95_request_time,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time) AS p99_request_time
            FROM access_logs
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: summary_hourly_stats")

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS summary_daily_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 day', timestamp) AS bucket,
                COUNT(*) AS total_requests,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
                COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
                COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
                COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
                AVG(request_time) AS avg_request_time,
                MAX(request_time) AS max_request_time,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time) AS p95_request_time,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY request_time) AS p99_request_time
            FROM access_logs
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: summary_daily_stats")

        # =====================================================================
        # GEO SUMMARY STATS CAGGs (from geo_events + geo_locations)
        # For: Summary page unique counts
        # Uses HyperLogLog for mergeable unique counts across any time range
        # =====================================================================

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS geo_summary_hourly_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 hour', ge.timestamp) AS bucket,
                COUNT(*) AS total_events,
                hyperloglog(32768, ge.ip_address) AS hll_ips,
                hyperloglog(32768, gl.country_code) AS hll_countries,
                hyperloglog(32768, gl.city) AS hll_cities
            FROM geo_events ge
            JOIN geo_locations gl ON ge.location_id = gl.id
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: geo_summary_hourly_stats")

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS geo_summary_daily_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 day', ge.timestamp) AS bucket,
                COUNT(*) AS total_events,
                hyperloglog(32768, ge.ip_address) AS hll_ips,
                hyperloglog(32768, gl.country_code) AS hll_countries,
                hyperloglog(32768, gl.city) AS hll_cities
            FROM geo_events ge
            JOIN geo_locations gl ON ge.location_id = gl.id
            GROUP BY bucket
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: geo_summary_daily_stats")

        # =====================================================================
        # LOCATION STATS CAGGs (from geo_events)
        # For: Map page GeoJSON with location counts
        # =====================================================================

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS location_hourly_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 hour', timestamp) AS bucket,
                location_id,
                COUNT(*) AS event_count
            FROM geo_events
            GROUP BY bucket, location_id
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: location_hourly_stats")

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS location_daily_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 day', timestamp) AS bucket,
                location_id,
                COUNT(*) AS event_count
            FROM geo_events
            GROUP BY bucket, location_id
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: location_daily_stats")

        # Create indexes on location stats for fast queries
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_location_hourly_bucket
            ON location_hourly_stats (bucket DESC)
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_location_hourly_location
            ON location_hourly_stats (location_id)
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_location_daily_bucket
            ON location_daily_stats (bucket DESC)
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_location_daily_location
            ON location_daily_stats (location_id)
        """))

        # =====================================================================
        # IP-LOCATION STATS CAGG (from geo_events)
        # For: Top IPs per location, Global top IPs
        # Daily granularity only (top IPs don't need hourly precision)
        # =====================================================================

        await conn.execute(text("""
            CREATE MATERIALIZED VIEW IF NOT EXISTS ip_location_daily_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('1 day', timestamp) AS bucket,
                location_id,
                ip_address,
                COUNT(*) AS event_count
            FROM geo_events
            GROUP BY bucket, location_id, ip_address
            WITH NO DATA
        """))
        logger.info("Continuous aggregate created/verified: ip_location_daily_stats")

        # Create indexes on ip_location_daily_stats for fast queries
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_ip_location_daily_stats_bucket
            ON ip_location_daily_stats (bucket DESC)
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_ip_location_daily_stats_location
            ON ip_location_daily_stats (location_id)
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_ip_location_daily_stats_location_ip
            ON ip_location_daily_stats (location_id, ip_address)
        """))

        # Add refresh policies for continuous aggregates
        refresh_interval = f"{analytics.cagg_refresh_interval_minutes} minutes"

        # Refresh policies for all CAGGs
        # Hourly CAGGs: refresh frequently with short lookback
        # Daily CAGGs: refresh less frequently with longer lookback
        for cagg, start_offset, end_offset in [
            # Summary stats (access logs)
            ("summary_hourly_stats", "3 hours", "1 hour"),
            ("summary_daily_stats", "3 days", "1 day"),
            # Geo summary stats (with HyperLogLog)
            ("geo_summary_hourly_stats", "3 hours", "1 hour"),
            ("geo_summary_daily_stats", "3 days", "1 day"),
            # Location stats (for map)
            ("location_hourly_stats", "3 hours", "1 hour"),
            ("location_daily_stats", "3 days", "1 day"),
            # IP location stats (for top IPs)
            ("ip_location_daily_stats", "3 days", "1 day"),
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

        # Add retention policies for hourly CAGGs
        hourly_caggs = [
            "summary_hourly_stats",
            "geo_summary_hourly_stats",
            "location_hourly_stats",
        ]
        for cagg in hourly_caggs:
            try:
                await conn.execute(text(f"""
                    SELECT add_retention_policy(
                        '{cagg}',
                        drop_after => INTERVAL '{analytics.hourly_retention_days} days',
                        if_not_exists => TRUE
                    )
                """))
                logger.info(
                    "Retention policy added/verified: %s (%d days)",
                    cagg,
                    analytics.hourly_retention_days,
                )
            except Exception as e:
                logger.debug("Retention policy for %s: %s", cagg, e)

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


async def _initial_cagg_refresh() -> None:
    """Perform initial refresh of all CAGGs to populate with historical data.

    This is needed because CAGGs are created with `WITH NO DATA` and the
    refresh policies only handle incremental updates. Real-time aggregation
    can't help if there's no materialized data to extend from.

    This runs outside a transaction since CALL statements require it.
    """
    engine = sqlalchemy_config.get_engine()

    caggs = [
        "summary_hourly_stats",
        "summary_daily_stats",
        "geo_summary_hourly_stats",
        "geo_summary_daily_stats",
        "location_hourly_stats",
        "location_daily_stats",
        "ip_location_daily_stats",
    ]

    for cagg in caggs:
        try:
            # CALL statements must run outside a transaction
            async with engine.connect() as conn:
                raw_conn = await conn.get_raw_connection()
                await raw_conn.driver_connection.execute(
                    f"CALL refresh_continuous_aggregate('{cagg}', NULL, NULL)"
                )
            logger.info("Initial refresh complete: %s", cagg)
        except Exception as e:
            logger.warning("Initial refresh failed for %s: %s", cagg, e)

    logger.info("Initial CAGG refresh complete")


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

    # Initial refresh of CAGGs to populate with any existing historical data
    await _initial_cagg_refresh()

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
