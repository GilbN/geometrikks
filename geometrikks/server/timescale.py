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
- url_{hourly,daily}_stats: Per-host-and-URL access-log counts (top URLs)
- user_agent_{hourly,daily}_stats: Per-user-agent counts (top user agents)
- host_daily_stats / hostname_daily_stats: Daily host rollups for facet dropdowns
- log_source_daily_stats: Daily hostname/log_format rollups for source facets
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Literal

from sqlalchemy import text

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from geometrikks.config.settings import AnalyticsSettings

logger = get_logger(__name__)


# =============================================================================
# Hostname Pollution Detection
# =============================================================================

# Docker stamps the short container ID as hostname when LOGPARSER_HOST_NAME
# is unset; 12 lowercase hex chars is that exact shape.
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{12}$")
CONTAINER_ID_THRESHOLD = 10
DISTINCT_HOSTNAME_CEILING = 50
# +1: fetching one past the ceiling proves it was exceeded without an
# unbounded DISTINCT over the hypertable.
_POLLUTION_PROBE_LIMIT = DISTINCT_HOSTNAME_CEILING + 1


@dataclass(frozen=True)
class HostnamePollution:
    distinct_count: int
    container_id_count: int

    @property
    def probe_capped(self) -> bool:
        """distinct_count is a floor, not a total: the probe hit its LIMIT."""
        return self.distinct_count >= _POLLUTION_PROBE_LIMIT

    @property
    def distinct_label(self) -> str:
        """Renders a capped count as `50+` so messages do not understate."""
        if self.probe_capped:
            return f"{DISTINCT_HOSTNAME_CEILING}+"
        return str(self.distinct_count)

    @property
    def reason(self) -> Literal["container-ids", "hostname-count"] | None:
        """Which threshold tripped; callers word their message from this."""
        if self.container_id_count >= CONTAINER_ID_THRESHOLD:
            return "container-ids"
        if self.distinct_count > DISTINCT_HOSTNAME_CEILING:
            return "hostname-count"
        return None

    @property
    def polluted(self) -> bool:
        return self.reason is not None


def classify_hostnames(hostnames: list[str]) -> HostnamePollution:
    """Pure classification so the heuristics are unit-testable without a DB."""
    return HostnamePollution(
        distinct_count=len(hostnames),
        container_id_count=sum(1 for h in hostnames if CONTAINER_ID_RE.match(h)),
    )


async def detect_hostname_pollution(conn: "AsyncConnection") -> HostnamePollution:
    """Bounded distinct-hostname probe against geo_events.

    GROUP BY + LIMIT streams groups off ix_geo_events_hostname and stops at
    the cap, so this stays cheap on large hypertables and does not depend on
    facet-CAGG freshness.
    """
    result = await conn.execute(text(
        "SELECT hostname FROM geo_events GROUP BY hostname ORDER BY hostname LIMIT :cap"
    ), {"cap": _POLLUTION_PROBE_LIMIT})
    return classify_hostnames([row.hostname for row in result])


_hostname_pollution: HostnamePollution | None = None


def get_hostname_pollution() -> HostnamePollution | None:
    """Result of the startup probe; None before setup_timescaledb ran."""
    return _hostname_pollution


def _set_hostname_pollution(value: HostnamePollution | None) -> None:
    global _hostname_pollution
    _hostname_pollution = value


@dataclass(frozen=True)
class PolicyFailure:
    policy: str
    target: str
    error: str


_policy_failures: list[PolicyFailure] = []


def get_policy_failures() -> list[PolicyFailure]:
    """Return policy intervals that could not be synced during the last setup run."""
    return list(_policy_failures)


def _record_policy_failure(policy: str, target: str, error: str) -> None:
    _policy_failures.append(PolicyFailure(policy, target, error))


def _reset_policy_failures() -> None:
    _policy_failures.clear()


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

    Used for: Summary page, Analytics charts. The `latency_*` pair repeats
    both over latency rows only (see `LATENCY_STATUS_EXCLUSIONS`).
    """
    await conn.execute(text(f"""
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
            COUNT(request_time) AS timed_requests,
            AVG(request_time) AS avg_request_time,
            MAX(request_time) AS max_request_time,
            percentile_agg(request_time) AS pct_agg,
            COUNT(request_time) FILTER (WHERE {LATENCY_FILTER}) AS latency_requests,
            AVG(request_time) FILTER (WHERE {LATENCY_FILTER}) AS avg_latency,
            MAX(request_time) FILTER (WHERE {LATENCY_FILTER}) AS max_latency,
            percentile_agg(request_time) FILTER (WHERE {LATENCY_FILTER}) AS latency_pct_agg
        FROM access_logs
        GROUP BY bucket
        WITH NO DATA
    """))
    logger.info("CAGG created/verified: summary_hourly_stats")

    await conn.execute(text(f"""
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
            COUNT(request_time) AS timed_requests,
            AVG(request_time) AS avg_request_time,
            MAX(request_time) AS max_request_time,
            percentile_agg(request_time) AS pct_agg,
            COUNT(request_time) FILTER (WHERE {LATENCY_FILTER}) AS latency_requests,
            AVG(request_time) FILTER (WHERE {LATENCY_FILTER}) AS avg_latency,
            MAX(request_time) FILTER (WHERE {LATENCY_FILTER}) AS max_latency,
            percentile_agg(request_time) FILTER (WHERE {LATENCY_FILTER}) AS latency_pct_agg
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
            hostname,
            COUNT(*) AS event_count
        FROM geo_events
        GROUP BY bucket, location_id, hostname
        WITH NO DATA
    """))
    logger.info("CAGG created/verified: location_hourly_stats")

    await conn.execute(text("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS location_daily_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 day', timestamp) AS bucket,
            location_id,
            hostname,
            COUNT(*) AS event_count
        FROM geo_events
        GROUP BY bucket, location_id, hostname
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
        # Pollution-gated skip leaves the pre-hostname view in place: probe
        # before creating, since a CREATE INDEX on a missing column would
        # abort the whole setup transaction (not just this statement).
        has_hostname = (await conn.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = 'hostname' LIMIT 1"
        ), {"table": f"location_{suffix}_stats"})).scalar()
        if has_hostname:
            await conn.execute(text(f"""
                CREATE INDEX IF NOT EXISTS ix_location_{suffix}_hostname
                ON location_{suffix}_stats (hostname, bucket DESC)
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
    """Create per-host-and-URL access-log CAGGs (hourly + daily).

    Used for: analytics /top-urls (unfiltered path). One group per host and
    path, so a path two vhosts share is not summed across them; a NULL host
    (combined-format archives carry none) is its own group. total_request_time
    is a SUM and timed_hits a COUNT of measured rows, so the rolled-up
    average is exact (SUM/COUNT of timed rows), never an AVG of AVGs. The
    `latency_*` pair repeats both over latency rows only (see
    `LATENCY_STATUS_EXCLUSIONS`).
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS url_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                host,
                url,
                COUNT(*) AS hits,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
                COUNT(request_time) AS timed_hits,
                COALESCE(SUM(bytes_sent), 0) AS total_bytes,
                SUM(request_time) AS total_request_time,
                COUNT(request_time) FILTER (WHERE {LATENCY_FILTER}) AS latency_hits,
                SUM(request_time) FILTER (WHERE {LATENCY_FILTER}) AS total_latency
            FROM access_logs
            WHERE url IS NOT NULL
            GROUP BY bucket, host, url
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


async def _create_asn_caggs(conn: "AsyncConnection") -> None:
    """Create per-ASN access-log CAGGs (hourly + daily) for /top-asns.

    max(as_org) keeps one series per ASN when an mmdb build renames the
    organization. Changing the column set means drop and recreate, which
    loses history older than raw retention.
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day")):
        await conn.execute(text(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS asn_{suffix}_stats
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{interval}', timestamp) AS bucket,
                autonomous_system_number AS asn,
                max(autonomous_system_organization) AS as_org,
                COUNT(*) AS hits,
                SUM(bytes_sent) AS total_bytes
            FROM access_logs
            WHERE autonomous_system_number IS NOT NULL
            GROUP BY bucket, autonomous_system_number
            WITH NO DATA
        """))
        logger.info("CAGG created/verified: asn_%s_stats", suffix)

        await conn.execute(text(f"""
            CREATE INDEX IF NOT EXISTS ix_asn_{suffix}_stats_bucket
            ON asn_{suffix}_stats (bucket DESC)
        """))


async def _create_host_facet_caggs(conn: "AsyncConnection") -> None:
    """Create tiny daily host/hostname/log-source CAGGs for the facet dropdowns.

    A DISTINCT over the raw hypertables scans every chunk (compressed chunks
    carry no usable btree for a loose index scan), which costs ~600ms at 18M
    rows for a handful of values. These daily rollups keep the facet reads at
    a few ms. Daily only: no query needs hourly host data.
    """
    await conn.execute(text("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS host_daily_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 day', timestamp) AS bucket,
            host,
            COUNT(*) AS hits
        FROM access_logs
        WHERE host IS NOT NULL
        GROUP BY bucket, host
        WITH NO DATA
    """))
    logger.info("CAGG created/verified: host_daily_stats")
    await conn.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_host_daily_stats_bucket
        ON host_daily_stats (bucket DESC)
    """))

    await conn.execute(text("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS hostname_daily_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 day', timestamp) AS bucket,
            hostname,
            COUNT(*) AS event_count
        FROM geo_events
        GROUP BY bucket, hostname
        WITH NO DATA
    """))
    logger.info("CAGG created/verified: hostname_daily_stats")
    await conn.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_hostname_daily_stats_bucket
        ON hostname_daily_stats (bucket DESC)
    """))

    await conn.execute(text("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS log_source_daily_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 day', timestamp) AS bucket,
            hostname,
            log_format,
            COUNT(*) AS hits
        FROM access_logs
        WHERE hostname IS NOT NULL OR log_format IS NOT NULL
        GROUP BY bucket, hostname, log_format
        WITH NO DATA
    """))
    logger.info("CAGG created/verified: log_source_daily_stats")
    await conn.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_log_source_daily_stats_bucket
        ON log_source_daily_stats (bucket DESC)
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
    ("asn_hourly_stats", "3 hours", "1 hour"),
    # Daily CAGGs: refresh up to 1 hour ago to keep data fresh
    # (using "1 day" would leave too large a gap for real-time aggregation)
    ("summary_daily_stats", "3 days", "1 hour"),
    ("geo_summary_daily_stats", "3 days", "1 hour"),
    ("location_daily_stats", "3 days", "1 hour"),
    ("ip_location_daily_stats", "3 days", "1 hour"),
    ("log_ip_daily_stats", "3 days", "1 hour"),
    ("url_daily_stats", "3 days", "1 hour"),
    ("user_agent_daily_stats", "3 days", "1 hour"),
    ("asn_daily_stats", "3 days", "1 hour"),
    ("host_daily_stats", "3 days", "1 hour"),
    ("hostname_daily_stats", "3 days", "1 hour"),
    ("log_source_daily_stats", "3 days", "1 hour"),
]

HOURLY_CAGGS = [
    "summary_hourly_stats",
    "geo_summary_hourly_stats",
    "location_hourly_stats",
    "ip_location_hourly_stats",
    "log_ip_hourly_stats",
    "url_hourly_stats",
    "user_agent_hourly_stats",
    "asn_hourly_stats",
]


def _interval_days(interval: str) -> float:
    """Days in a ``'<n> hours'`` / ``'<n> days'`` policy interval."""
    amount, unit = interval.split()
    if unit.startswith("hour"):
        return int(amount) / 24
    if unit.startswith("day"):
        return int(amount)
    raise ValueError(f"Unsupported policy interval unit: {interval!r}")


def check_refresh_offsets(*, raw_retention_days: int) -> None:
    """Refuse a raw retention that a CAGG refresh window would reach past.

    A refresh recomputes every bucket in ``[now - start_offset, now -
    end_offset]`` from the source hypertable. Once retention has dropped the
    raw chunks under part of that window, the refresh finds nothing there
    and deletes the materialized rows, silently, on every run. Raising here
    fails startup before any policy is touched.

    Raises:
        ValueError: when any refresh ``start_offset`` is at or beyond
            ``raw_retention_days``.
    """
    reaching = [
        (cagg, start_offset)
        for cagg, start_offset, _end in CAGG_REFRESH_CONFIG
        if _interval_days(start_offset) >= raw_retention_days
    ]
    if not reaching:
        return
    minimum = int(max(_interval_days(offset) for _cagg, offset in reaching)) + 1
    cagg, start_offset = reaching[0]
    others = f" and {len(reaching) - 1} more" if len(reaching) > 1 else ""
    raise ValueError(
        f"ANALYTICS_RAW_RETENTION_DAYS={raw_retention_days} is inside the "
        f"{start_offset} refresh window of {cagg}{others}: each refresh would "
        "recompute buckets from raw rows retention has already dropped and "
        "delete the materialized rows. Set ANALYTICS_RAW_RETENTION_DAYS to "
        f"at least {minimum}."
    )


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
        try:
            await _sync_policy_schedule(
                conn, policy="refresh", proc="policy_refresh_continuous_aggregate", target=cagg,
                interval=timedelta(minutes=refresh_interval_minutes),
            )
        except Exception as e:
            logger.warning("policy_update_failed", policy="refresh", target=cagg, error=str(e))
            _record_policy_failure("refresh", cagg, str(e))


async def _add_retention_policies(
    conn: "AsyncConnection",
    raw_retention_days: int,
    debug_retention_days: int,
    hourly_retention_days: int,
) -> None:
    """Add retention policies for hypertables and hourly CAGGs, and point
    the ones that already exist at the configured drop_after."""
    retention_configs = [
        ("geo_events", raw_retention_days),
        ("access_logs", raw_retention_days),
        ("access_log_debug", debug_retention_days),
        *((cagg, hourly_retention_days) for cagg in HOURLY_CAGGS),
    ]

    for target, days in retention_configs:
        try:
            await conn.execute(text(f"""
                SELECT add_retention_policy(
                    '{target}',
                    drop_after => INTERVAL '{days} days',
                    if_not_exists => TRUE
                )
            """))
            logger.info("Retention policy added/verified: %s (%d days)", target, days)
        except Exception as e:
            logger.debug("Retention policy for %s: %s", target, e)
        try:
            await _sync_policy_config(
                conn, policy="retention", proc="policy_retention", target=target,
                key="drop_after", interval=timedelta(days=days),
            )
        except Exception as e:
            logger.warning("policy_update_failed", policy="retention", target=target, error=str(e))
            _record_policy_failure("retention", target, str(e))


_POLICY_JOB_FOR_TARGET = """
    FROM timescaledb_information.jobs j
    LEFT JOIN timescaledb_information.continuous_aggregates c
           ON c.materialization_hypertable_schema = j.hypertable_schema
          AND c.materialization_hypertable_name = j.hypertable_name
    WHERE j.proc_name = :proc
      AND COALESCE(c.view_name, j.hypertable_name) = :target
"""


async def _sync_policy_config(
    conn: "AsyncConnection", *, policy: str, proc: str, target: str, key: str, interval: timedelta
) -> None:
    """Update an existing policy whose config interval differs from the setting.

    Every ``add_*_policy(if_not_exists => TRUE)`` only issues a notice when
    the policy already exists, so a changed ``ANALYTICS_*`` setting would
    otherwise never reach the database. A CAGG's policies hang off its
    materialization hypertable, hence the continuous_aggregates join.
    """
    rows = (await conn.execute(text(f"""
        SELECT j.job_id, j.config->>:key AS current {_POLICY_JOB_FOR_TARGET}
          AND (j.config->>:key)::interval IS DISTINCT FROM :interval
    """), {"proc": proc, "target": target, "key": key, "interval": interval})).all()
    after = f"{interval.days} days"
    for job_id, current in rows:
        await conn.execute(text("""
            SELECT alter_job(
                :job_id,
                config => (SELECT config FROM timescaledb_information.jobs WHERE job_id = :job_id)
                          || jsonb_build_object(CAST(:key AS text), CAST(:after AS text))
            )
        """), {"job_id": job_id, "key": key, "after": after})
        logger.info("policy_updated", policy=policy, target=target, before=current, after=after)


async def _sync_policy_schedule(
    conn: "AsyncConnection", *, policy: str, proc: str, target: str, interval: timedelta
) -> None:
    """Update an existing policy whose schedule_interval differs from the setting."""
    rows = (await conn.execute(text(f"""
        SELECT j.job_id, j.schedule_interval {_POLICY_JOB_FOR_TARGET}
          AND j.schedule_interval IS DISTINCT FROM :interval
    """), {"proc": proc, "target": target, "interval": interval})).all()
    for job_id, current in rows:
        await conn.execute(
            text("SELECT alter_job(:job_id, schedule_interval => :interval)"),
            {"job_id": job_id, "interval": interval},
        )
        logger.info(
            "policy_updated", policy=policy, target=target, before=str(current), after=str(interval)
        )


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
        try:
            await _sync_policy_config(
                conn, policy="compression", proc="policy_compression", target=table,
                key="compress_after", interval=timedelta(days=compression_after_days),
            )
        except Exception as e:
            logger.warning("policy_update_failed", policy="compression", target=table, error=str(e))
            _record_policy_failure("compression", table, str(e))


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
    "asn_hourly_stats",
    "asn_daily_stats",
    "host_daily_stats",
    "hostname_daily_stats",
    "log_source_daily_stats",
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

# Rows whose request_time is a connection's lifetime, not a response time.
# 101 is the WebSocket upgrade handshake: nginx and Traefik log the whole
# connection under it, so a day-long socket reads as a day-long request.
# 0 is "no status written" (nginx logs 000, Traefik 0), a connection that
# ended before any response; its duration is time-to-abort.
LATENCY_STATUS_EXCLUSIONS: tuple[int, ...] = (0, 101)


def latency_filter(alias: str = "") -> str:
    """SQL predicate selecting latency rows; ``alias`` prefixes the column.

    Args:
        alias: Table alias including the dot, e.g. ``"al."``, or empty.
    """
    codes = ", ".join(str(code) for code in LATENCY_STATUS_EXCLUSIONS)
    return f"{alias}status_code NOT IN ({codes})"


LATENCY_FILTER = latency_filter()


@dataclass(frozen=True)
class CaggColumn:
    """A column a continuous aggregate gains after its first release.

    Fresh installs get it from the CREATE statement; existing views get it
    in place from ``_add_cagg_columns`` with the same expression.
    """

    name: str
    sql_type: str
    expression: str

    @property
    def ddl(self) -> str:
        return f"{self.name} {self.sql_type} GENERATED ALWAYS AS ({self.expression}) STORED"


@dataclass(frozen=True)
class CaggGeneration:
    """One release's worth of columns added to a continuous aggregate.

    ``count`` names the generation's COUNT column. A COUNT is 0, never NULL,
    once a bucket has been refreshed, so a NULL there means the bucket
    predates this generation's forced refresh and still needs it. Every
    generation carries its own count so the probe can check each one; a
    refresh interrupted while backfilling an older generation is caught
    even after a newer generation's refresh completed.
    """

    count: str
    columns: tuple[CaggColumn, ...]


_SUMMARY_GENERATIONS: tuple[CaggGeneration, ...] = (
    CaggGeneration("timed_requests", (
        CaggColumn("timed_requests", "bigint", "COUNT(request_time)"),
    )),
    CaggGeneration("latency_requests", (
        CaggColumn("latency_requests", "bigint", f"COUNT(request_time) FILTER (WHERE {LATENCY_FILTER})"),
        CaggColumn("avg_latency", "double precision", f"AVG(request_time) FILTER (WHERE {LATENCY_FILTER})"),
        CaggColumn("max_latency", "double precision", f"MAX(request_time) FILTER (WHERE {LATENCY_FILTER})"),
        CaggColumn("latency_pct_agg", "uddsketch", f"percentile_agg(request_time) FILTER (WHERE {LATENCY_FILTER})"),
    )),
)
_URL_GENERATIONS: tuple[CaggGeneration, ...] = (
    CaggGeneration("timed_hits", (
        CaggColumn("timed_hits", "bigint", "COUNT(request_time)"),
    )),
    CaggGeneration("latency_hits", (
        CaggColumn("latency_hits", "bigint", f"COUNT(request_time) FILTER (WHERE {LATENCY_FILTER})"),
        CaggColumn("total_latency", "double precision", f"SUM(request_time) FILTER (WHERE {LATENCY_FILTER})"),
    )),
)

# View -> generations added after the view first shipped, oldest first. A
# database missing several gets them all in one pass and one forced refresh.
CAGG_GENERATIONS: dict[str, tuple[CaggGeneration, ...]] = {
    "summary_hourly_stats": _SUMMARY_GENERATIONS,
    "summary_daily_stats": _SUMMARY_GENERATIONS,
    "url_hourly_stats": _URL_GENERATIONS,
    "url_daily_stats": _URL_GENERATIONS,
}

# Flat view of the same table for callers that only need the columns.
CAGG_COLUMNS: dict[str, tuple[CaggColumn, ...]] = {
    view: tuple(column for generation in generations for column in generation.columns)
    for view, generations in CAGG_GENERATIONS.items()
}


async def _cagg_columns_need_upgrade(
    conn: "AsyncConnection", *, raw_retention_days: int
) -> list[str]:
    """Views missing an upgrade column, or not yet backfilled after one.

    A view that does not exist yet needs nothing: the CREATE includes every
    column. "Any bucket with a NULL generation count" is the rerun-safe half
    of the rule: a container killed during the forced refresh comes back
    with the columns present and history still uncounted, and must refresh
    again. One query per view checks every generation's count at once.

    That half is scoped to the raw retention window, the only span the forced
    refresh can recount. Daily buckets older than it keep a NULL count for
    good (their raw rows are gone), and an unscoped probe would see those and
    schedule the full refresh again on every start. Readers fall back to the
    bucket's older columns for them.

    Args:
        conn: Open connection inside the setup transaction.
        raw_retention_days: Window the forced refresh covers.
    """
    result = await conn.execute(text("""
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name = ANY(:views) AND table_schema = 'public'
    """), {"views": list(CAGG_COLUMNS)})
    columns = {(r.table_name, r.column_name) for r in result}
    existing_views = {name for name, _ in columns}
    pending: list[str] = []
    for view, generations in CAGG_GENERATIONS.items():
        if view not in existing_views:
            continue
        if any((view, column.name) not in columns for column in CAGG_COLUMNS[view]):
            pending.append(view)
            continue
        null_counts = " OR ".join(f"{generation.count} IS NULL" for generation in generations)
        has_null = (await conn.execute(
            text(
                f"SELECT 1 FROM {view} WHERE ({null_counts}) "
                f"AND bucket >= now() - make_interval(days => :days) LIMIT 1"
            ),
            {"days": raw_retention_days},
        )).scalar()
        if has_null:
            pending.append(view)
    return pending


async def _add_cagg_columns(conn: "AsyncConnection", views: list[str]) -> list[str]:
    """Add every missing upgrade column of ``views`` in place.

    The in-place ALTER keeps every existing bucket; only the new columns are
    filled by the forced refresh the caller runs afterwards. TimescaleDB
    versions without in-place CAGG columns raise here, and for those the
    old percentile-upgrade route applies: drop the view (setup recreates it
    with the columns) and accept that daily history older than raw retention
    cannot be rebuilt.

    Returns:
        Views that were dropped and will be recreated by the CREATE step.
    """
    dropped: list[str] = []
    for view in views:
        existing = {
            row.column_name
            for row in await conn.execute(text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = :view AND table_schema = 'public'
            """), {"view": view})
        }
        missing = [column for column in CAGG_COLUMNS[view] if column.name not in existing]
        try:
            for column in missing:
                # Savepoint: a failed DDL poisons the whole setup transaction, so
                # without one the fallback DROP below would hit "current
                # transaction is aborted" and take startup down with it.
                async with conn.begin_nested():
                    await conn.execute(text(
                        f"ALTER MATERIALIZED VIEW {view} ADD COLUMN {column.ddl}"
                    ))
                logger.info("cagg_column_added", view=view, column=column.name)
        except Exception as exc:
            logger.warning(
                "In-place column add failed on %s (%s); recreating the view. "
                "History older than the raw retention window cannot be rebuilt "
                "and is discarded.",
                view,
                exc,
            )
            await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE"))
            dropped.append(view)
    return dropped


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


LOCATION_CAGGS = ["location_hourly_stats", "location_daily_stats"]

_location_caggs_have_hostname: bool = False


def location_caggs_have_hostname() -> bool:
    """Startup-cached CAGG capability; False means hostname filters go raw."""
    return _location_caggs_have_hostname


def _set_location_caggs_have_hostname(value: bool) -> None:
    global _location_caggs_have_hostname
    _location_caggs_have_hostname = value


async def _location_caggs_need_upgrade(conn: "AsyncConnection") -> bool:
    """True when any existing location CAGG is in the pre-hostname shape.

    Every existing CAGG must carry the column, not just one of them: the
    upgrade drops and recreates the pair, so declaring victory on a partial
    match would strand the laggard in the old shape forever while the
    capability flag sends hostname-filtered queries at it.
    """
    existing = (await conn.execute(text("""
        SELECT count(*) FROM information_schema.views
        WHERE table_name = ANY(:views) AND table_schema = 'public'
    """), {"views": LOCATION_CAGGS})).scalar_one()
    if not existing:
        return False
    with_hostname = (await conn.execute(text("""
        SELECT count(DISTINCT table_name) FROM information_schema.columns
        WHERE table_name = ANY(:views) AND column_name = 'hostname' AND table_schema = 'public'
    """), {"views": LOCATION_CAGGS})).scalar_one()
    return with_hostname < existing


URL_CAGGS = ["url_hourly_stats", "url_daily_stats"]


async def _url_caggs_need_upgrade(conn: "AsyncConnection") -> bool:
    """True when an existing URL CAGG is in the pre-host shape.

    A GROUP BY cannot change in place, so the pair is dropped and recreated
    together; as with the location CAGGs, a partial match must not declare
    victory or the laggard stays in the old shape forever.
    """
    existing = (await conn.execute(text("""
        SELECT count(*) FROM information_schema.views
        WHERE table_name = ANY(:views) AND table_schema = 'public'
    """), {"views": URL_CAGGS})).scalar_one()
    if not existing:
        return False
    with_host = (await conn.execute(text("""
        SELECT count(DISTINCT table_name) FROM information_schema.columns
        WHERE table_name = ANY(:views) AND column_name = 'host' AND table_schema = 'public'
    """), {"views": URL_CAGGS})).scalar_one()
    return with_host < existing


async def _drop_url_caggs(conn: "AsyncConnection", *, attempts: int = 3) -> None:
    """Drop both URL CAGGs, retrying a transient catalog error.

    A refresh-policy job running on the view makes the DROP fail with
    "tuple concurrently deleted". Each attempt runs in a savepoint: a
    failed DDL poisons the setup transaction until the savepoint rolls
    back, and without one the retry would hit "current transaction is
    aborted". The last failure propagates and startup fails, the same
    contract as the location upgrade.
    """
    for cagg in URL_CAGGS:
        for attempt in range(attempts):
            try:
                async with conn.begin_nested():
                    await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
                break
            except Exception:
                if attempt == attempts - 1:
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))


async def setup_timescaledb(
    engine: "AsyncEngine",
    analytics: "AnalyticsSettings",
) -> None:
    """Set up TimescaleDB hypertables, continuous aggregates, and policies.

    This function is idempotent - safe to call on every startup.

    Args:
        engine: SQLAlchemy async engine.
        analytics: Analytics settings for policy configuration.

    Raises:
        ValueError: when the raw retention is inside a CAGG refresh window
            (see ``check_refresh_offsets``).
    """
    check_refresh_offsets(raw_retention_days=analytics.raw_retention_days)
    _reset_policy_failures()

    async with engine.begin() as conn:
        # Enable extensions
        await _enable_extensions(conn)

        # Create hypertables
        await _create_hypertables(conn)

        # Upgrade pre-percentile_agg summary CAGGs (drop; recreated below)
        upgraded = await _summary_caggs_need_upgrade(conn)
        if upgraded:
            await _upgrade_summary_caggs(conn)

        # Rebuild pre-host URL CAGGs: a GROUP BY cannot change in place.
        # Runs before the column probe, which skips views that no longer
        # exist, so the drop never races an in-place ALTER on the same view.
        url_upgrade = await _url_caggs_need_upgrade(conn)
        if url_upgrade:
            await _drop_url_caggs(conn)
            logger.warning(
                "url_caggs_recreated",
                views=URL_CAGGS,
                detail="host dimension added; per-URL history older than the "
                "raw retention window cannot be rebuilt and is discarded",
            )

        # Add the upgrade columns (timed-row counts, latency figures) to
        # pre-existing summary/URL CAGGs. Probed before the CREATE step:
        # CREATE IF NOT EXISTS never alters an existing view. The forced
        # refresh runs after policies, outside the transaction (CALL cannot
        # run inside one).
        pending_views = await _cagg_columns_need_upgrade(
            conn, raw_retention_days=analytics.raw_retention_days
        )
        if pending_views:
            recreated = await _add_cagg_columns(conn, pending_views)
            if recreated:
                logger.info("cagg_views_recreated", views=recreated)

        # Upgrade pre-hostname location CAGGs, gated on hostname pollution:
        # migrating polluted (container-ID) hostnames would make the map's
        # per-source filter useless, so the old shape is kept until the
        # deployment consolidates hostnames and restarts.
        location_upgrade = await _location_caggs_need_upgrade(conn)
        pollution = await detect_hostname_pollution(conn)
        _set_hostname_pollution(pollution)
        if location_upgrade and pollution.polluted:
            if pollution.reason == "container-ids":
                logger.warning(
                    "Skipping the location-CAGG hostname upgrade: %d of %s distinct "
                    "hostnames look like Docker container IDs. Map source filtering "
                    "stays on raw scans. Run `litestar backfill-hostname NAME "
                    "--consolidate`, then restart to migrate.",
                    pollution.container_id_count,
                    pollution.distinct_label,
                )
            else:
                logger.warning(
                    "Skipping the location-CAGG hostname upgrade: %s distinct "
                    "recording hostnames is above the %d ceiling. Map source "
                    "filtering stays on raw scans.",
                    pollution.distinct_label,
                    DISTINCT_HOSTNAME_CEILING,
                )
            location_upgrade = False
        elif location_upgrade:
            for cagg in LOCATION_CAGGS:
                await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
            logger.warning(
                "Recreating location CAGGs with a hostname dimension; history "
                "older than the raw retention window cannot be rebuilt and is "
                "discarded."
            )

        # Create continuous aggregates
        await _create_summary_caggs(conn)
        await _create_geo_summary_caggs(conn)
        await _create_location_caggs(conn)
        await _create_ip_location_cagg(conn)
        await _create_log_ip_caggs(conn)
        await _create_url_caggs(conn)
        await _create_user_agent_caggs(conn)
        await _create_asn_caggs(conn)
        await _create_host_facet_caggs(conn)

        _set_location_caggs_have_hostname(
            not await _location_caggs_need_upgrade(conn)
        )

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

    if location_upgrade:
        await refresh_caggs_range(
            engine,
            start=datetime.now(timezone.utc) - timedelta(days=analytics.raw_retention_days),
            end=datetime.now(timezone.utc),
            caggs=LOCATION_CAGGS,
        )

    if url_upgrade:
        started = time.monotonic()
        failed = await refresh_caggs_range(
            engine,
            start=datetime.now(timezone.utc) - timedelta(days=analytics.raw_retention_days),
            end=datetime.now(timezone.utc),
            caggs=URL_CAGGS,
        )
        if failed:
            # The views exist with every column but no history; the next
            # start's gap probe (backfill_cagg_gaps) sees the empty
            # materialization and refreshes it from the raw rows.
            logger.warning("url_caggs_refresh_failed", views=failed)
        logger.info(
            "url_caggs_refresh_done",
            views=[view for view in URL_CAGGS if view not in failed],
            seconds=round(time.monotonic() - started, 1),
        )

    if pending_views:
        started = time.monotonic()
        failed = await refresh_caggs_range(
            engine,
            start=datetime.now(timezone.utc) - timedelta(days=analytics.raw_retention_days),
            end=datetime.now(timezone.utc),
            caggs=pending_views,
            force=True,
        )
        if failed:
            # The columns are there but those views' history stays unfilled;
            # the next start finds the NULL counts and refreshes them again.
            logger.warning("cagg_columns_refresh_failed", views=failed)
        logger.info(
            "cagg_columns_refresh_done",
            views=[view for view in pending_views if view not in failed],
            seconds=round(time.monotonic() - started, 1),
        )

    # Repair deployments whose data predates CAGG refresh coverage
    # (issue #14: long-range charts truncated while top lists are not).
    await backfill_cagg_gaps(
        engine,
        raw_retention_days=analytics.raw_retention_days,
        hourly_retention_days=analytics.hourly_retention_days,
    )

    logger.info("TimescaleDB setup complete")


async def refresh_caggs_range(
    engine: AsyncEngine,
    *,
    start: datetime,
    end: datetime,
    caggs: list[str] | None = None,
    force: bool = False,
) -> list[str]:
    """Refresh CAGGs for a specific time range (used after historical imports).

    Timestamps are bound as asyncpg parameters. CAGG names cannot be bound
    (identifiers), so they are validated against the ALL_CAGGS allowlist.

    Never raises on a refresh failure (startup and the scheduler must survive
    one), but returns the CAGGs that could not be refreshed so callers whose
    correctness depends on it - the backfill commands, whose written rows stay
    invisible to analytics until the aggregates catch up - can report or exit
    nonzero. An empty list means every requested CAGG refreshed.

    Args:
        engine: Async engine (raw asyncpg connection is used: CALL cannot
            run inside a transaction block).
        start: Range start (inclusive), timezone-aware.
        end: Range end (exclusive), timezone-aware.
        caggs: Optional subset of CAGGs (defaults to all).
        force: Re-materialize buckets that are already up to date. Needed
            once after a column is added to an existing view, since a normal
            refresh skips buckets it considers current.

    Returns:
        Names of CAGGs whose refresh failed; empty when all succeeded.
    """
    if not start or not end:
        raise ValueError("Both start and end must be provided")

    target_caggs = caggs or ALL_CAGGS
    unknown = set(target_caggs) - set(ALL_CAGGS)
    if unknown:
        raise ValueError(f"Unknown CAGG name(s): {sorted(unknown)}")

    failed: list[str] = []
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
                    force_arg = ", force => true" if force else ""
                    await driver_conn.execute(
                        f"CALL refresh_continuous_aggregate('{cagg}', $1::timestamptz, $2::timestamptz{force_arg})",
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
                failed.append(cagg)
                break
    return failed


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
    "asn_hourly_stats": "access_logs",
    "asn_daily_stats": "access_logs",
    "host_daily_stats": "access_logs",
    "hostname_daily_stats": "geo_events",
    "log_source_daily_stats": "access_logs",
}


async def backfill_cagg_gaps(
    engine: "AsyncEngine", *, raw_retention_days: int, hourly_retention_days: int
) -> None:
    """Materialize CAGG history that predates refresh-policy coverage.

    CAGGs are created WITH NO DATA and refresh policies only cover a
    trailing window, so buckets older than the coverage are never
    materialized. Once the watermark advances, the real-time union stops
    reading those raw rows and the history disappears from CAGG queries
    while raw-table queries still see it (issue #14 symptom). Detect the
    gap (earliest raw row older than earliest materialized bucket) and
    refresh the missing range. Idempotent and cheap when there is no gap.

    Hourly CAGGs keep only ``hourly_retention_days`` of buckets, so their
    probe horizon is clamped to that window: when raw retention is longer,
    buckets beyond hourly retention are deliberately dropped, and treating
    them as a gap would re-backfill (and re-drop) the same ~120 days of
    hourly buckets on every startup.
    """
    now = datetime.now(timezone.utc)
    raw_horizon = now - timedelta(days=raw_retention_days)
    hourly_horizon = now - timedelta(days=hourly_retention_days)
    to_backfill: list[tuple[str, datetime]] = []

    for cagg, source in CAGG_SOURCE_TABLES.items():
        horizon = max(raw_horizon, hourly_horizon) if cagg in HOURLY_CAGGS else raw_horizon
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

