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
- ip_location_{hourly,daily}_stats: Per-IP counts by location for top IPs
- log_ip_{hourly,daily}_stats: Per-IP access-log counts (top IPs/countries/cities, facets)
- url_{hourly,daily}_stats: Per-URL access-log counts (top URLs)
- user_agent_{hourly,daily}_stats: Per-user-agent counts (top user agents)
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import text

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from geometrikks.config.settings import AnalyticsSettings

logger = get_logger(__name__)


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
            percentile_agg(request_time) AS pct_agg
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
            percentile_agg(request_time) AS pct_agg
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
    """Create IP-location stats CAGGs (hourly + daily).

    Used for: Top IPs per location, Global top IPs, grouped geo-logs rows.

    Both granularities exist so the query layer can honour the same routing
    the summary/location CAGGs use (hourly for 24h-30d, daily above). Serving
    a 14-day range from the daily CAGG forces callers to align the window to
    a whole day, which over-counts the partial first day.
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS ip_location_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                location_id,
                ip_address,
                COUNT(*) AS event_count
            FROM geo_events
            GROUP BY bucket, location_id, ip_address
            WITH NO DATA
        """))
        logger.info("CAGG created/verified: ip_location_%s_stats", suffix)

        # Create indexes for fast queries
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_ip_location_{suffix}_stats_bucket
            ON ip_location_{suffix}_stats (bucket DESC)
        """))
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_ip_location_{suffix}_stats_location
            ON ip_location_{suffix}_stats (location_id)
        """))
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_ip_location_{suffix}_stats_location_ip
            ON ip_location_{suffix}_stats (location_id, ip_address)
        """))
        # Banned-IP overlay filters thousands of IPs at once (CAPI blocklist)
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_ip_location_{suffix}_stats_ip_bucket
            ON ip_location_{suffix}_stats (ip_address, bucket DESC)
        """))


async def _create_log_ip_caggs(conn: "AsyncConnection") -> None:
    """Create per-IP access-log CAGGs (hourly + daily).

    Used for: analytics /top-ips, /top-countries, /top-cities and the
    access-log country/city facets. Keyed by IP (with its country/city), so
    COUNT(DISTINCT ip_address) per country/city stays exact and
    country/city/IP filters apply directly to CAGG columns.
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS log_ip_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                ip_address,
                country_code,
                city,
                MAX(country_name) AS country_name,
                COUNT(*) AS hits,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes
            FROM access_logs
            GROUP BY bucket, ip_address, country_code, city
            WITH NO DATA
        """))
        logger.info("CAGG created/verified: log_ip_%s_stats", suffix)

        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_log_ip_{suffix}_stats_bucket
            ON log_ip_{suffix}_stats (bucket DESC)
        """))
        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_log_ip_{suffix}_stats_ip_bucket
            ON log_ip_{suffix}_stats (ip_address, bucket DESC)
        """))


async def _create_url_caggs(conn: "AsyncConnection") -> None:
    """Create per-URL access-log CAGGs (hourly + daily).

    Used for: analytics /top-urls (unfiltered path). total_request_time is a
    SUM so the rolled-up average is exact (SUM/SUM), never an AVG of AVGs.
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS url_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                url,
                COUNT(*) AS hits,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                SUM(request_time) AS total_request_time
            FROM access_logs
            WHERE url IS NOT NULL
            GROUP BY bucket, url
            WITH NO DATA
        """))
        logger.info("CAGG created/verified: url_%s_stats", suffix)

        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_url_{suffix}_stats_bucket
            ON url_{suffix}_stats (bucket DESC)
        """))


async def _create_user_agent_caggs(conn: "AsyncConnection") -> None:
    """Create per-user-agent access-log CAGGs (hourly + daily).

    Used for: analytics /top-user-agents (unfiltered path).
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS user_agent_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                user_agent,
                COUNT(*) AS hits
            FROM access_logs
            WHERE user_agent IS NOT NULL
            GROUP BY bucket, user_agent
            WITH NO DATA
        """))
        logger.info("CAGG created/verified: user_agent_%s_stats", suffix)

        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_user_agent_{suffix}_stats_bucket
            ON user_agent_{suffix}_stats (bucket DESC)
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
    ("ip_location_hourly_stats", "3 hours", "1 hour"),
    ("log_ip_hourly_stats", "3 hours", "1 hour"),
    ("url_hourly_stats", "3 hours", "1 hour"),
    ("user_agent_hourly_stats", "3 hours", "1 hour"),
    # Daily CAGGs: refresh up to 1 hour ago to keep data fresh
    # (using "1 day" would leave too large a gap for real-time aggregation)
    ("summary_daily_stats", "3 days", "1 hour"),
    ("geo_summary_daily_stats", "3 days", "1 hour"),
    ("location_daily_stats", "3 days", "1 hour"),
    ("ip_location_daily_stats", "3 days", "1 hour"),
    ("log_ip_daily_stats", "3 days", "1 hour"),
    ("url_daily_stats", "3 days", "1 hour"),
    ("user_agent_daily_stats", "3 days", "1 hour"),
]

HOURLY_CAGGS = [
    "summary_hourly_stats",
    "geo_summary_hourly_stats",
    "location_hourly_stats",
    "ip_location_hourly_stats",
    "log_ip_hourly_stats",
    "url_hourly_stats",
    "user_agent_hourly_stats",
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
    "ip_location_hourly_stats",
    "ip_location_daily_stats",
    "log_ip_hourly_stats",
    "log_ip_daily_stats",
    "url_hourly_stats",
    "url_daily_stats",
    "user_agent_hourly_stats",
    "user_agent_daily_stats",
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


SUMMARY_CAGGS = ["summary_hourly_stats", "summary_daily_stats"]


async def _summary_caggs_need_upgrade(conn: "AsyncConnection") -> bool:
    """True when a summary CAGG exists in the pre-percentile_agg shape.

    CAGGs are plain views over the internal materialized hypertable, so
    information_schema.columns lists their columns directly — one probe is
    enough.
    """
    result = await conn.execute(text("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = ANY(:views) AND column_name = 'p50_request_time'
        LIMIT 1
    """), {"views": SUMMARY_CAGGS})
    return bool(result.scalar())


async def _upgrade_summary_caggs(conn: "AsyncConnection") -> None:
    """Drop old-shape summary CAGGs so setup recreates them with pct_agg.

    Materialized data is lost and rebuilt from raw access_logs: refresh
    policies backfill their windows and the caller schedules a full refresh.
    CAVEAT: raw data only survives raw_retention_days (default 180d), so
    daily-summary history OLDER than that cannot be rebuilt and is
    permanently discarded by this upgrade.
    """
    for cagg in SUMMARY_CAGGS:
        await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
        logger.warning(
            "Recreating %s with percentile_agg (old percentile columns were mathematically wrong)",
            cagg,
        )


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

        # Upgrade pre-percentile_agg summary CAGGs (drop; recreated below)
        upgraded = await _summary_caggs_need_upgrade(conn)
        if upgraded:
            await _upgrade_summary_caggs(conn)

        # Create continuous aggregates
        await _create_summary_caggs(conn)
        await _create_geo_summary_caggs(conn)
        await _create_location_caggs(conn)
        await _create_ip_location_cagg(conn)
        await _create_log_ip_caggs(conn)
        await _create_url_caggs(conn)
        await _create_user_agent_caggs(conn)

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

    if upgraded:
        # Rebuild the recreated summary CAGGs from raw logs. Bounded by the
        # raw retention window: older raw rows are already dropped, so
        # refreshing further back is pure waste.
        await refresh_caggs_range(
            engine,
            start=datetime.now(timezone.utc) - timedelta(days=analytics.raw_retention_days),
            end=datetime.now(timezone.utc),
            caggs=SUMMARY_CAGGS,
        )

    # Repair deployments whose data predates CAGG refresh coverage
    # (issue #14: long-range charts truncated while top lists are not).
    await backfill_cagg_gaps(engine, raw_retention_days=analytics.raw_retention_days)

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
        # A background refresh-policy job on an overlapping window makes
        # refresh_continuous_aggregate raise "concurrent refresh"; without a
        # retry the range would silently stay stale until the next policy run
        # (which may never cover it, e.g. historical imports).
        for attempt in range(5):
            try:
                async with engine.connect() as conn:
                    raw_conn = await conn.get_raw_connection()
                    driver_conn = raw_conn.driver_connection
                    if driver_conn is None:
                        raise RuntimeError("No driver connection available for CALL statement")
                    await driver_conn.execute(
                        f"CALL refresh_continuous_aggregate('{cagg}', $1::timestamptz, $2::timestamptz)",
                        start,
                        end,
                    )
                logger.info("CAGG refreshed: %s (%s → %s)", cagg, start, end)
                break
            except Exception as e:
                if "concurrent refresh" in str(e) and attempt < 4:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                logger.warning("CAGG refresh failed: %s (%s → %s): %s", cagg, start, end, e)
                break


# CAGG -> raw source hypertable (all use a "timestamp" time column)
CAGG_SOURCE_TABLES: dict[str, str] = {
    "summary_hourly_stats": "access_logs",
    "summary_daily_stats": "access_logs",
    "geo_summary_hourly_stats": "geo_events",
    "geo_summary_daily_stats": "geo_events",
    "location_hourly_stats": "geo_events",
    "location_daily_stats": "geo_events",
    "ip_location_hourly_stats": "geo_events",
    "ip_location_daily_stats": "geo_events",
    "log_ip_hourly_stats": "access_logs",
    "log_ip_daily_stats": "access_logs",
    "url_hourly_stats": "access_logs",
    "url_daily_stats": "access_logs",
    "user_agent_hourly_stats": "access_logs",
    "user_agent_daily_stats": "access_logs",
}


async def backfill_cagg_gaps(engine: "AsyncEngine", *, raw_retention_days: int) -> None:
    """Materialize CAGG history that predates refresh-policy coverage.

    CAGGs are created WITH NO DATA and refresh policies only cover a
    trailing window, so buckets older than the coverage are never
    materialized. Once the watermark advances, the real-time union stops
    reading those raw rows and the history disappears from CAGG queries
    while raw-table queries still see it (issue #14 symptom). Detect the
    gap (earliest raw row older than earliest materialized bucket) and
    refresh the missing range. Idempotent and cheap when there is no gap.
    """
    horizon = datetime.now(timezone.utc) - timedelta(days=raw_retention_days)
    to_backfill: list[tuple[str, datetime]] = []

    for cagg, source in CAGG_SOURCE_TABLES.items():
        # Isolate each CAGG on its own connection: a probe failure (e.g. a
        # future CAGG whose time column is not "bucket") must not abort app
        # startup, and a failed statement poisons its whole connection's
        # transaction, so a shared connection would cascade the failure to
        # every later CAGG. Matches refresh_caggs_range's per-item pattern.
        try:
            async with engine.connect() as conn:
                raw_min = (await conn.execute(
                    text(f"SELECT MIN(timestamp) FROM {source} WHERE timestamp >= :horizon"),  # noqa: S608 - allowlisted identifiers
                    {"horizon": horizon},
                )).scalar()
                if raw_min is None:
                    continue

                mat_table = (await conn.execute(text("""
                    SELECT format('%I.%I', materialization_hypertable_schema,
                                  materialization_hypertable_name)
                    FROM timescaledb_information.continuous_aggregates
                    WHERE view_name = :cagg
                """), {"cagg": cagg})).scalar()
                if mat_table is None:
                    continue

                cagg_min = (await conn.execute(
                    text(f"SELECT MIN(bucket) FROM {mat_table}")  # noqa: S608
                )).scalar()
        except Exception as e:
            logger.warning("CAGG gap probe failed: %s: %s", cagg, e)
            continue

        bucket_width = timedelta(days=1) if "daily" in cagg else timedelta(hours=1)
        if cagg_min is None or raw_min < cagg_min - bucket_width:
            # refresh_continuous_aggregate silently skips the bucket
            # containing an unaligned start (it does not floor it), so
            # align start to the bucket boundary or the earliest row's
            # bucket is dropped instead of backfilled.
            if bucket_width == timedelta(days=1):
                aligned_start = raw_min.replace(hour=0, minute=0, second=0, microsecond=0)
            else:
                aligned_start = raw_min.replace(minute=0, second=0, microsecond=0)
            to_backfill.append((cagg, aligned_start))

    for cagg, start in to_backfill:
        logger.warning("CAGG %s is missing history since %s; backfilling", cagg, start)
        await refresh_caggs_range(
            engine, start=start, end=datetime.now(timezone.utc), caggs=[cagg]
        )

