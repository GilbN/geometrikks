"""Summary and URL CAGGs carry a timed-row count; old-shape views upgrade in place."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

import pytest

from geometrikks.config.settings import get_settings
from geometrikks.server import timescale
from geometrikks.server.timescale import refresh_caggs_range, setup_timescaledb

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
RETENTION_DAYS = get_settings().analytics.raw_retention_days

OLD_SUMMARY_HOURLY = """
    CREATE MATERIALIZED VIEW summary_hourly_stats
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
"""


async def _seed(session_maker) -> None:
    """Two hours: the older one has 3 timed + 2 untimed rows, the newer 4 untimed."""
    async with session_maker() as session:
        older = NOW - timedelta(hours=3)
        newer = NOW - timedelta(hours=2)
        for rt in (0.01, 0.02, 0.03, None, None):
            await session.execute(text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, request_time) "
                "VALUES (:ts, '10.0.0.1', 'GET', '/x', 200, 100, :rt)"
            ), {"ts": older, "rt": rt})
        for _ in range(4):
            await session.execute(text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, request_time) "
                "VALUES (:ts, '10.0.0.2', 'GET', '/y', 200, 100, NULL)"
            ), {"ts": newer})
        await session.commit()


async def test_fresh_views_have_the_count_columns(pg_engine) -> None:
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_name IN ('summary_hourly_stats', 'summary_daily_stats', 'url_hourly_stats', 'url_daily_stats')
        """))
        cols = {(r.table_name, r.column_name) for r in rows}
    for view, column in timescale.TIMED_COUNT_COLUMNS.items():
        assert (view, column) in cols


async def test_counts_follow_the_timed_rows(pg_engine, pg_session_maker, clean_tables) -> None:
    await _seed(pg_session_maker)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=1), end=NOW + timedelta(hours=1),
        caggs=["summary_hourly_stats", "url_hourly_stats"],
    )
    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT bucket, total_requests, timed_requests, avg_request_time "
            "FROM summary_hourly_stats WHERE bucket >= :s ORDER BY bucket"
        ), {"s": NOW - timedelta(days=1)})).all()
        url_rows = (await conn.execute(text(
            "SELECT url, hits, timed_hits, total_request_time FROM url_hourly_stats WHERE bucket >= :s ORDER BY url"
        ), {"s": NOW - timedelta(days=1)})).all()
    assert [(r.total_requests, r.timed_requests) for r in rows] == [(5, 3), (4, 0)]
    assert rows[0].avg_request_time == pytest.approx(0.02)
    assert rows[1].avg_request_time is None
    assert [(r.url, r.hits, r.timed_hits) for r in url_rows] == [("/x", 5, 3), ("/y", 4, 0)]
    assert url_rows[1].total_request_time is None


async def test_old_shape_summary_view_upgrades_in_place(pg_engine, pg_session_maker, clean_tables) -> None:
    """Recreate the pre-count shape, populate it, compress the chunk, run setup.

    The column must appear, old buckets must be counted, the raw chunk must
    still be compressed, and a second setup must find nothing to upgrade.
    """
    await _seed(pg_session_maker)
    async with pg_engine.begin() as conn:
        await conn.execute(text("DROP MATERIALIZED VIEW IF EXISTS summary_hourly_stats CASCADE"))
        await conn.execute(text(OLD_SUMMARY_HOURLY))
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=1), end=NOW + timedelta(hours=1),
        caggs=["summary_hourly_stats"],
    )
    async with pg_engine.begin() as conn:
        compressed_chunks = (await conn.execute(text(
            "SELECT compress_chunk(c, true) FROM show_chunks('access_logs', newer_than => INTERVAL '2 days') c"
        ))).scalars().all()
        needs = await timescale._timed_columns_need_upgrade(
            conn, raw_retention_days=RETENTION_DAYS
        )
    assert compressed_chunks
    assert "summary_hourly_stats" in needs

    await setup_timescaledb(pg_engine, get_settings().analytics)

    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT total_requests, timed_requests FROM summary_hourly_stats WHERE bucket >= :s ORDER BY bucket"
        ), {"s": NOW - timedelta(days=1)})).all()
        still_compressed = (await conn.execute(text(
            "SELECT count(*) FROM timescaledb_information.chunks "
            "WHERE is_compressed AND format('%I.%I', chunk_schema, chunk_name) = ANY(:names)"
        ), {"names": compressed_chunks})).scalar_one()
        needs_after = await timescale._timed_columns_need_upgrade(
            conn, raw_retention_days=RETENTION_DAYS
        )
    assert [(r.total_requests, r.timed_requests) for r in rows] == [(5, 3), (4, 0)]
    assert still_compressed == len(compressed_chunks)
    assert "summary_hourly_stats" not in needs_after


async def _restore_view(pg_engine, view: str) -> None:
    """Drop a view the test recreated and let setup rebuild it empty.

    A test that refreshes its own window pushes the view's watermark past
    now, which would hide a later test's rows from the real-time union. A
    freshly created CAGG has no watermark, so the union covers everything
    again.
    """
    async with pg_engine.begin() as conn:
        await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE"))
    await setup_timescaledb(pg_engine, get_settings().analytics)


ADD_TIMED_REQUESTS = (
    "ALTER MATERIALIZED VIEW summary_hourly_stats ADD COLUMN timed_requests bigint "
    "GENERATED ALWAYS AS (COUNT(request_time)) STORED"
)

OLD_SUMMARY_DAILY = """
    CREATE MATERIALIZED VIEW summary_daily_stats
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
"""


async def _insert(session_maker, ts: datetime, request_time: float | None) -> None:
    async with session_maker() as session:
        await session.execute(text(
            "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, request_time) "
            "VALUES (:ts, '10.0.0.3', 'GET', '/z', 200, 100, :rt)"
        ), {"ts": ts, "rt": request_time})
        await session.commit()


async def test_present_column_with_null_counts_triggers_the_refresh_only(
    pg_engine, pg_session_maker, clean_tables
) -> None:
    """A start killed mid-refresh leaves the column in place and history NULL.

    The next start must not try to add the column again; it must refresh the
    buckets that still carry no count.
    """
    await _seed(pg_session_maker)
    async with pg_engine.begin() as conn:
        await conn.execute(text("DROP MATERIALIZED VIEW IF EXISTS summary_hourly_stats CASCADE"))
        await conn.execute(text(OLD_SUMMARY_HOURLY))
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=1), end=NOW + timedelta(hours=1),
        caggs=["summary_hourly_stats"],
    )
    async with pg_engine.begin() as conn:
        await conn.execute(text(ADD_TIMED_REQUESTS))
        needs = await timescale._timed_columns_need_upgrade(
            conn, raw_retention_days=RETENTION_DAYS
        )
        uncounted = (await conn.execute(text(
            "SELECT count(*) FROM summary_hourly_stats "
            "WHERE bucket >= :s AND timed_requests IS NULL"
        ), {"s": NOW - timedelta(days=1)})).scalar_one()
    assert uncounted == 2
    assert "summary_hourly_stats" in needs

    await setup_timescaledb(pg_engine, get_settings().analytics)

    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT total_requests, timed_requests FROM summary_hourly_stats "
            "WHERE bucket >= :s ORDER BY bucket"
        ), {"s": NOW - timedelta(days=1)})).all()
        needs_after = await timescale._timed_columns_need_upgrade(
            conn, raw_retention_days=RETENTION_DAYS
        )
    assert [(r.total_requests, r.timed_requests) for r in rows] == [(5, 3), (4, 0)]
    assert needs_after == []

    await _restore_view(pg_engine, "summary_hourly_stats")


async def test_buckets_beyond_the_raw_window_keep_their_pre_upgrade_figures(
    pg_engine, pg_session_maker, clean_tables
) -> None:
    """Daily buckets whose raw rows are gone stay uncounted, and stay quiet.

    They cannot be recounted, so the probe must ignore them (otherwise every
    start reruns the full forced refresh) and the readers must fall back to
    the bucket's total instead of reporting zero timed requests.
    """
    old_ts = NOW - timedelta(days=RETENTION_DAYS + 20)
    recent_ts = NOW - timedelta(days=2)
    await _insert(pg_session_maker, old_ts, 0.5)
    await _insert(pg_session_maker, recent_ts, 0.25)
    async with pg_engine.begin() as conn:
        await conn.execute(text("DROP MATERIALIZED VIEW IF EXISTS summary_daily_stats CASCADE"))
        await conn.execute(text(OLD_SUMMARY_DAILY))
    await refresh_caggs_range(
        pg_engine, start=old_ts - timedelta(days=1), end=NOW + timedelta(hours=1),
        caggs=["summary_daily_stats"],
    )
    async with pg_engine.begin() as conn:
        await conn.execute(text(
            "SELECT drop_chunks('access_logs', older_than => make_interval(days => :days))"
        ), {"days": RETENTION_DAYS + 10})

    await setup_timescaledb(pg_engine, get_settings().analytics)

    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT bucket, total_requests, timed_requests FROM summary_daily_stats "
            "WHERE bucket >= :s ORDER BY bucket"
        ), {"s": old_ts - timedelta(days=1)})).all()
        needs_after = await timescale._timed_columns_need_upgrade(
            conn, raw_retention_days=RETENTION_DAYS
        )
    assert [(r.total_requests, r.timed_requests) for r in rows] == [(1, None), (1, 1)]
    assert needs_after == [], "an unrecountable bucket must not reschedule the refresh"

    from geometrikks.domain.analytics.repositories import SummaryStatsRepository

    async with pg_session_maker() as session:
        summary = await SummaryStatsRepository(session=session).get_summary(
            old_ts - timedelta(days=1), NOW + timedelta(hours=1)
        )
    assert summary is not None
    assert summary.total_log_records == 2
    assert summary.timed_requests == 2, "the pre-upgrade bucket counts all its rows as timed"

    await _restore_view(pg_engine, "summary_daily_stats")
