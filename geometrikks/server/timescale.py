"""TimescaleDB setup and configuration.

This module handles all TimescaleDB-specific setup including:
- Extension activation (timescaledb, timescaledb_toolkit)
- Hypertable creation and migration
- Continuous aggregate (CAGG) definitions
- Refresh, retention, and compression policies

CAGG Structure:
- summary_hourly_stats / summary_daily_stats: Access log metrics
- geo_summary_hourly_stats / geo_summary_daily_stats: Geo metrics with HyperLogLog
- location_hourly_stats / location_daily_stats: Location event counts for map
- ip_location_daily_stats: Per-IP counts by location for top IPs
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from geometrikks.config.settings import AnalyticsSettings

logger = logging.getLogger(__name__)


# =============================================================================
# Hypertable Configuration
# =============================================================================

HYPERTABLES = [
    # (table_name, time_column, chunk_interval, pk_constraint_name)
    ("geo_events", "timestamp", "1 day", "pk_geo_events"),
    ("access_logs", "timestamp", "1 day", "pk_access_logs"),
    ("access_log_debug", "created_at", "1 week", "pk_access_log_debug"),
]


async def _enable_extensions(conn: "AsyncConnection") -> None:
    """Enable TimescaleDB and toolkit extensions."""
    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE"))
    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit CASCADE"))
    logger.info("TimescaleDB and toolkit extensions enabled")


async def _create_hypertables(conn: "AsyncConnection") -> None:
    """Convert tables to TimescaleDB hypertables."""
    for table, time_col, chunk_interval, pk_name in HYPERTABLES:
        try:
            # Check if already a hypertable
            result = await conn.execute(text(f"""
                SELECT 1 FROM timescaledb_information.hypertables
                WHERE hypertable_name = '{table}'
            """))
            if result.scalar():
                logger.debug("Hypertable already exists: %s", table)
                continue

            # Drop existing primary key constraint
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


# =============================================================================
# Continuous Aggregate Definitions
# =============================================================================

async def _create_summary_caggs(conn: "AsyncConnection") -> None:
    """Create summary stats CAGGs from access_logs.

    Used for: Summary page, Analytics charts
    """
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
    logger.info("CAGG created/verified: summary_hourly_stats")

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
    logger.info("CAGG created/verified: summary_daily_stats")


async def _create_geo_summary_caggs(conn: "AsyncConnection") -> None:
    """Create geo summary stats CAGGs with HyperLogLog.

    Used for: Summary page unique counts (IPs, countries, cities)
    HyperLogLog enables mergeable unique counts across any time range.
    """
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
    logger.info("CAGG created/verified: geo_summary_hourly_stats")

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
    logger.info("CAGG created/verified: geo_summary_daily_stats")


async def _create_location_caggs(conn: "AsyncConnection") -> None:
    """Create location stats CAGGs.

    Used for: Map page GeoJSON with location event counts
    """
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
    logger.info("CAGG created/verified: location_hourly_stats")

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
    logger.info("CAGG created/verified: location_daily_stats")

    # Create indexes for fast queries
    for suffix in ["hourly", "daily"]:
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_location_{suffix}_bucket
            ON location_{suffix}_stats (bucket DESC)
        """))
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_location_{suffix}_location
            ON location_{suffix}_stats (location_id)
        """))


async def _create_ip_location_cagg(conn: "AsyncConnection") -> None:
    """Create IP-location stats CAGG.

    Used for: Top IPs per location, Global top IPs
    Daily granularity only (top IPs don't need hourly precision)
    """
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
    logger.info("CAGG created/verified: ip_location_daily_stats")

    # Create indexes for fast queries
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


# =============================================================================
# Policy Configuration
# =============================================================================

# (cagg_name, start_offset, end_offset)
# Note: end_offset controls how close to "now" the refresh goes.
# Smaller end_offset = more up-to-date materialized data.
# Real-time aggregation fills the gap between materialized data and now.
CAGG_REFRESH_CONFIG = [
    # Hourly CAGGs: refresh up to 1 hour ago, real-time fills the current hour
    ("summary_hourly_stats", "3 hours", "1 hour"),
    ("geo_summary_hourly_stats", "3 hours", "1 hour"),
    ("location_hourly_stats", "3 hours", "1 hour"),
    # Daily CAGGs: refresh up to 1 hour ago to keep data fresh
    # (using "1 day" would leave too large a gap for real-time aggregation)
    ("summary_daily_stats", "3 days", "1 hour"),
    ("geo_summary_daily_stats", "3 days", "1 hour"),
    ("location_daily_stats", "3 days", "1 hour"),
    ("ip_location_daily_stats", "3 days", "1 hour"),
]

HOURLY_CAGGS = [
    "summary_hourly_stats",
    "geo_summary_hourly_stats",
    "location_hourly_stats",
]


async def _add_refresh_policies(
    conn: "AsyncConnection",
    refresh_interval_minutes: int,
) -> None:
    """Add refresh policies for all CAGGs."""
    refresh_interval = f"{refresh_interval_minutes} minutes"

    for cagg, start_offset, end_offset in CAGG_REFRESH_CONFIG:
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


async def _add_retention_policies(
    conn: "AsyncConnection",
    raw_retention_days: int,
    debug_retention_days: int,
    hourly_retention_days: int,
) -> None:
    """Add retention policies for hypertables and hourly CAGGs."""
    # Hypertable retention
    retention_configs = [
        ("geo_events", raw_retention_days),
        ("access_logs", raw_retention_days),
        ("access_log_debug", debug_retention_days),
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

    # Hourly CAGG retention
    for cagg in HOURLY_CAGGS:
        try:
            await conn.execute(text(f"""
                SELECT add_retention_policy(
                    '{cagg}',
                    drop_after => INTERVAL '{hourly_retention_days} days',
                    if_not_exists => TRUE
                )
            """))
            logger.info("Retention policy added/verified: %s (%d days)", cagg, hourly_retention_days)
        except Exception as e:
            logger.debug("Retention policy for %s: %s", cagg, e)


async def _add_compression_policies(
    conn: "AsyncConnection",
    compression_after_days: int,
) -> None:
    """Add compression policies for hypertables."""
    for table, time_col in [
        ("geo_events", "timestamp"),
        ("access_logs", "timestamp"),
        ("access_log_debug", "created_at"),
    ]:
        try:
            # Enable compression on the hypertable
            await conn.execute(text(f"""
                ALTER TABLE {table} SET (
                    timescaledb.compress,
                    timescaledb.compress_orderby = '{time_col} DESC'
                )
            """))
            # Add compression policy
            await conn.execute(text(f"""
                SELECT add_compression_policy(
                    '{table}',
                    compress_after => INTERVAL '{compression_after_days} days',
                    if_not_exists => TRUE
                )
            """))
            logger.info(
                "Compression policy added/verified: %s (after %d days)",
                table,
                compression_after_days,
            )
        except Exception as e:
            logger.debug("Compression policy for %s: %s", table, e)


async def _enable_realtime_aggregation(conn: "AsyncConnection") -> None:
    """Enable real-time aggregation on all CAGGs.

    By default (TimescaleDB 2.7+), CAGGs are created with
    materialized_only = true, meaning queries return only materialized data.

    Setting materialized_only = false enables real-time aggregation,
    which merges materialized data with any non-materialized time
    ranges from the underlying hypertable (typically the current
    incomplete bucket).
    """

    for cagg in ALL_CAGGS:
        try:
            await conn.execute(text(f"""
                ALTER MATERIALIZED VIEW {cagg} SET (timescaledb.materialized_only = false)
            """))
            logger.debug("Real-time aggregation enabled: %s", cagg)
        except Exception as e:
            logger.debug("Real-time aggregation for %s: %s", cagg, e)

    logger.info("Real-time aggregation enabled for all CAGGs")


# =============================================================================
# Public API
# =============================================================================

# All CAGGs for refresh operations
ALL_CAGGS = [
    "summary_hourly_stats",
    "summary_daily_stats",
    "geo_summary_hourly_stats",
    "geo_summary_daily_stats",
    "location_hourly_stats",
    "location_daily_stats",
    "ip_location_daily_stats",
]


async def teardown_timescaledb(conn: "AsyncConnection") -> None:
    """Tear down TimescaleDB objects so metadata.drop_all() can succeed.

    Must be called BEFORE metadata.drop_all() to avoid dependency errors.

    Args:
        conn: SQLAlchemy async connection
    """
    # Check TimescaleDB exists
    try:
        result = await conn.execute(text("""
            SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
        """))
        if not result.scalar():
            logger.debug("TimescaleDB extension not found, skipping teardown")
            return
    except Exception:
        logger.exception("Could not check TimescaleDB extension")
        return

    # 1. Drop CAGGs
    for cagg in ALL_CAGGS:
        try:
            await conn.execute(
                text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE")
            )
            logger.debug("Dropped CAGG: %s", cagg)
        except Exception as e:
            logger.warning("Failed to drop CAGG %s: %s", cagg, e)

    # 2. Drop hypertables
    for table, _, _, _ in HYPERTABLES:
        try:
            await conn.execute(text("""
                SELECT drop_hypertable(:table, if_exists => TRUE)
            """), {"table": table})
            logger.debug("Dropped hypertable: %s", table)
        except Exception as e:
            logger.warning("Failed to drop hypertable %s: %s", table, e)

    logger.info("TimescaleDB teardown complete")


async def setup_timescaledb(
    engine: "AsyncEngine",
    analytics: "AnalyticsSettings",
) -> None:
    """Set up TimescaleDB hypertables, continuous aggregates, and policies.

    This function is idempotent - safe to call on every startup.

    Args:
        engine: SQLAlchemy async engine.
        analytics: Analytics settings for policy configuration.
    """
    async with engine.begin() as conn:
        # Enable extensions
        await _enable_extensions(conn)

        # Create hypertables
        await _create_hypertables(conn)

        # Create continuous aggregates
        await _create_summary_caggs(conn)
        await _create_geo_summary_caggs(conn)
        await _create_location_caggs(conn)
        await _create_ip_location_cagg(conn)

        # Enable real-time aggregation (merges materialized + live data)
        await _enable_realtime_aggregation(conn)

        # Add policies
        await _add_refresh_policies(conn, analytics.cagg_refresh_interval_minutes)
        await _add_retention_policies(
            conn,
            analytics.raw_retention_days,
            analytics.debug_retention_days,
            analytics.hourly_retention_days,
        )
        await _add_compression_policies(conn, analytics.compression_after_days)

    logger.info("TimescaleDB setup complete")


async def refresh_caggs_range(
    engine: AsyncEngine,
    *,
    start: datetime,
    end: datetime,
    caggs: list[str] | None = None,
) -> None:
    """Refresh CAGGs for a specific time range (used after historical imports).

    Timestamps are bound as asyncpg parameters. CAGG names cannot be bound
    (identifiers), so they are validated against the ALL_CAGGS allowlist.

    Args:
        engine: Async engine (raw asyncpg connection is used: CALL cannot
            run inside a transaction block).
        start: Range start (inclusive), timezone-aware.
        end: Range end (exclusive), timezone-aware.
        caggs: Optional subset of CAGGs (defaults to all).
    """
    if not start or not end:
        raise ValueError("Both start and end must be provided")

    target_caggs = caggs or ALL_CAGGS
    unknown = set(target_caggs) - set(ALL_CAGGS)
    if unknown:
        raise ValueError(f"Unknown CAGG name(s): {sorted(unknown)}")

    for cagg in target_caggs:
        try:
            async with engine.connect() as conn:
                raw_conn = await conn.get_raw_connection()
                await raw_conn.driver_connection.execute(
                    f"CALL refresh_continuous_aggregate('{cagg}', $1::timestamptz, $2::timestamptz)",
                    start,
                    end,
                )
            logger.info("CAGG refreshed: %s (%s → %s)", cagg, start, end)
        except Exception as e:
            logger.warning("CAGG refresh failed: %s (%s → %s): %s", cagg, start, end, e)

