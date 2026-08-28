"""Latency figures skip upgraded (101) and unanswered (0) connections.

Seeds one hour of ordinary traffic plus WebSocket rows whose request_time
is a connection lifetime, refreshes the aggregates, and reads every path
the analytics API uses. The upgrade tests rebuild the views in their
pre-latency shape and run setup against them.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.domain.analytics.repositories import (
    LiveStatsRepository,
    StatsGranularity,
    SummaryStatsRepository,
)
from geometrikks.server.timescale import (
    CAGG_COLUMNS,
    _add_cagg_columns,
    _cagg_columns_need_upgrade,
    refresh_caggs_range,
)

pytestmark = pytest.mark.anyio

# Wall-clock derived and hour-aligned: the scratch DB has live retention and
# refresh policies, and the CAGG path needs a range longer than 24h.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
BUSY_HOUR = NOW - timedelta(days=2, hours=2)
SOCKET_ONLY_HOUR = NOW - timedelta(days=2, hours=5)
RANGE = (NOW - timedelta(days=3), NOW)

LATENCY_VIEWS = ["summary_hourly_stats", "summary_daily_stats", "url_hourly_stats", "url_daily_stats"]

INSERT = text(
    "INSERT INTO access_logs (timestamp, ip_address, method, url, "
    "status_code, bytes_sent, request_time) "
    "VALUES (:ts, '10.0.0.1', 'GET', :url, :status, :bytes, :rt)"
)


async def _seed(session_maker) -> None:
    async with session_maker() as session:
        for i in range(20):
            await session.execute(INSERT, {
                "ts": BUSY_HOUR + timedelta(seconds=i), "url": "/api",
                "status": 200, "bytes": 100, "rt": 0.2,
            })
        await session.execute(INSERT, {
            "ts": BUSY_HOUR + timedelta(minutes=1), "url": "/ws/live",
            "status": 101, "bytes": 512, "rt": 9000.0,
        })
        await session.execute(INSERT, {
            "ts": BUSY_HOUR + timedelta(minutes=2), "url": "/ws/live",
            "status": 0, "bytes": 0, "rt": 5000.0,
        })
        await session.execute(INSERT, {
            "ts": SOCKET_ONLY_HOUR, "url": "/ws/crowdsec",
            "status": 101, "bytes": 256, "rt": 3000.0,
        })
        await session.commit()


async def _refresh_all(pg_engine) -> None:
    failed = await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=5), end=NOW + timedelta(hours=1),
        caggs=LATENCY_VIEWS,
    )
    assert failed == []


async def test_summary_and_time_series_skip_socket_lifetimes(pg_engine, pg_session_maker, clean_tables):
    await _seed(pg_session_maker)
    await _refresh_all(pg_engine)

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        via_cagg = await repo.get_summary(*RANGE)  # > 24h routes to the CAGGs
        via_raw = await repo._get_summary_from_raw(*RANGE)
        live = await LiveStatsRepository(session=session).get_summary(*RANGE)
        series = await repo.get_time_series(*RANGE, granularity=StatsGranularity.HOURLY)
        live_series = await LiveStatsRepository(session=session).get_time_series(
            *RANGE, bucket_interval="1 hour"
        )

    for stats in (via_cagg, via_raw, live):
        assert stats is not None
        assert stats.total_log_records == 23
        assert stats.timed_requests == 20
        assert stats.avg_request_time == pytest.approx(0.2)
        assert stats.max_request_time == pytest.approx(0.2)
        assert stats.p99_request_time is not None and stats.p99_request_time < 1.0

    for points in (series, live_series):
        busy = next(p for p in points if p.bucket == BUSY_HOUR)
        assert busy.total_requests == 22
        assert busy.timed_requests == 20
        assert busy.max_request_time == pytest.approx(0.2)
        socket_only = next(p for p in points if p.bucket == SOCKET_ONLY_HOUR)
        assert socket_only.total_requests == 1
        assert socket_only.timed_requests == 0
        assert socket_only.avg_request_time is None
        assert socket_only.max_request_time is None
        assert socket_only.p99_request_time is None


async def test_top_urls_show_na_for_socket_endpoints(pg_engine, pg_session_maker, clean_tables):
    await _seed(pg_session_maker)
    await _refresh_all(pg_engine)

    async with pg_session_maker() as session:
        stitched = await SummaryStatsRepository(session=session).get_top_urls(*RANGE)
        raw = await LiveStatsRepository(session=session).get_top_urls(*RANGE)

    for rows in (stitched, raw):
        by_url = {r.url: r for r in rows}
        assert by_url["/api"].hits == 20
        assert by_url["/api"].timed_hits == 20
        assert by_url["/api"].avg_request_time == pytest.approx(0.2)
        assert by_url["/ws/live"].hits == 2
        assert by_url["/ws/live"].timed_hits == 0
        assert by_url["/ws/live"].avg_request_time is None


async def test_local_day_rollup_skips_socket_lifetimes(pg_engine, pg_session_maker, clean_tables):
    """The non-UTC daily branch sums hourly buckets, weights the mean by the
    latency count and merges the filtered sketches through the fallback
    CASE; a socket-only hour must contribute a NULL sketch, not 3000 s.
    Etc/GMT-2 is a fixed UTC+2 so the expectations do not move with DST."""
    await _seed(pg_session_maker)
    await _refresh_all(pg_engine)

    async with pg_session_maker() as session:
        days = await SummaryStatsRepository(session=session).get_time_series(
            *RANGE, granularity=StatsGranularity.DAILY, tz="Etc/GMT-2"
        )

    assert days, "a 3-day range in a non-UTC zone must produce local-day buckets"
    assert sum(d.total_requests for d in days) == 23
    assert sum(d.timed_requests for d in days) == 20
    busy = [d for d in days if d.timed_requests > 0]
    assert len(busy) == 1
    assert busy[0].avg_request_time == pytest.approx(0.2)
    assert busy[0].max_request_time == pytest.approx(0.2)
    assert busy[0].p99_request_time is not None and busy[0].p99_request_time < 1.0
    for day in days:
        if day.timed_requests == 0:
            assert day.avg_request_time is None
            assert day.max_request_time is None
            assert day.p99_request_time is None


PRE_LATENCY_SUMMARY = """
    CREATE MATERIALIZED VIEW {name}
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{bucket}', timestamp) AS bucket,
        COUNT(*) AS total_requests,
        COALESCE(SUM(bytes_sent), 0) AS total_bytes,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
        COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
        COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
        COUNT(request_time) AS timed_requests,
        AVG(request_time) AS avg_request_time,
        MAX(request_time) AS max_request_time,
        percentile_agg(request_time) AS pct_agg
    FROM access_logs
    GROUP BY bucket
    WITH NO DATA
"""
PRE_LATENCY_URL = """
    CREATE MATERIALIZED VIEW {name}
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{bucket}', timestamp) AS bucket,
        url,
        COUNT(*) AS hits,
        COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
        COUNT(request_time) AS timed_hits,
        COALESCE(SUM(bytes_sent), 0) AS total_bytes,
        SUM(request_time) AS total_request_time
    FROM access_logs
    WHERE url IS NOT NULL
    GROUP BY bucket, url
    WITH NO DATA
"""
SHAPES = {
    LATENCY_VIEWS[0]: (PRE_LATENCY_SUMMARY, "1 hour"),
    LATENCY_VIEWS[1]: (PRE_LATENCY_SUMMARY, "1 day"),
    LATENCY_VIEWS[2]: (PRE_LATENCY_URL, "1 hour"),
    LATENCY_VIEWS[3]: (PRE_LATENCY_URL, "1 day"),
}


async def _install_pre_latency_views(pg_engine) -> None:
    async with pg_engine.begin() as conn:
        for view, (shape, bucket) in SHAPES.items():
            await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE"))
            await conn.execute(text(shape.format(name=view, bucket=bucket)))


async def _columns(pg_engine) -> set[tuple[str, str]]:
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_name = ANY(:views)
        """), {"views": list(SHAPES)})
        return {(r.table_name, r.column_name) for r in rows}


async def test_setup_adds_and_fills_the_latency_columns_in_place(pg_engine, pg_session_maker, clean_tables):
    from geometrikks.config.settings import get_settings
    from geometrikks.server.timescale import setup_timescaledb

    await _seed(pg_session_maker)
    await _install_pre_latency_views(pg_engine)
    await _refresh_all(pg_engine)
    before = await _columns(pg_engine)
    assert ("summary_hourly_stats", "max_latency") not in before

    await setup_timescaledb(pg_engine, get_settings().analytics)

    after = await _columns(pg_engine)
    for view, columns in CAGG_COLUMNS.items():
        for column in columns:
            assert (view, column.name) in after, (view, column.name)
    async with pg_engine.connect() as conn:
        row = (await conn.execute(text("""
            SELECT latency_requests, max_latency, max_request_time
            FROM summary_hourly_stats WHERE bucket = :b
        """), {"b": BUSY_HOUR})).one()
        assert row.latency_requests == 20
        assert row.max_latency == pytest.approx(0.2)
        assert row.max_request_time == pytest.approx(9000.0)
        assert await _cagg_columns_need_upgrade(
            conn, raw_retention_days=get_settings().analytics.raw_retention_days
        ) == [], "a completed upgrade must not be scheduled again"


async def test_pre_upgrade_buckets_fall_back_to_their_unfiltered_figures(pg_engine, pg_session_maker, clean_tables):
    """Columns added but not yet refreshed: the readers must not go blank,
    and must not blank a socket-only hour once the refresh has run."""
    from geometrikks.config.settings import get_settings
    from geometrikks.server.timescale import setup_timescaledb

    await _seed(pg_session_maker)
    await _install_pre_latency_views(pg_engine)
    await _refresh_all(pg_engine)
    async with pg_engine.begin() as conn:
        assert await _add_cagg_columns(conn, list(SHAPES)) == []

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        stale = await repo.get_summary(*RANGE)
        stale_urls = await repo.get_top_urls(*RANGE)
    assert stale is not None
    assert stale.timed_requests == 23
    assert stale.max_request_time == pytest.approx(9000.0)
    assert {r.url: r.timed_hits for r in stale_urls}["/ws/live"] == 2

    await setup_timescaledb(pg_engine, get_settings().analytics)  # forced refresh fills the columns

    async with pg_session_maker() as session:
        fresh = await SummaryStatsRepository(session=session).get_summary(*RANGE)
    assert fresh is not None
    assert fresh.timed_requests == 20
    assert fresh.max_request_time == pytest.approx(0.2)
