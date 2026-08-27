"""Summary CAGGs must expose pct_agg and correct percentiles after upgrade."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.server.timescale import refresh_caggs_range

import pytest

pytestmark = pytest.mark.anyio

# Derived from the wall clock, not hard-coded: the scratch DB has live
# retention/refresh policies, so a fixed date would age out of their windows
# (see test_repositories_pg.py). Hour-aligned for deterministic bucketing.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _seed_latency_data(session_maker) -> None:
    """100 requests over 3 days: 99 at 10ms, one 10s outlier in the newest day."""
    async with session_maker() as session:
        for day in range(3):
            ts = NOW - timedelta(days=day, hours=2)
            for i in range(33):
                # access_logs is an id-only base: no created_at/updated_at.
                await session.execute(text(
                    "INSERT INTO access_logs (timestamp, ip_address, method, url, "
                    "status_code, bytes_sent, request_time) "
                    "VALUES (:ts, '10.0.0.1', 'GET', '/x', 200, 100, :rt)"
                ), {"ts": ts, "rt": 10.0 if (day == 0 and i == 0) else 0.01})
        await session.commit()


async def test_summary_caggs_have_pct_agg_column(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_name IN ('summary_hourly_stats', 'summary_daily_stats')
        """))
        cols = {(r.table_name, r.column_name) for r in rows}
    for view in ("summary_hourly_stats", "summary_daily_stats"):
        assert (view, "pct_agg") in cols
        assert (view, "p50_request_time") not in cols


async def test_rolled_up_percentile_is_sane(pg_engine, pg_session_maker, clean_tables):
    """The rolled-up p50 over all buckets must be ~10ms despite the 10s
    outlier, and p99 must reflect the outlier's tail — and crucially
    approx_percentile(rollup(pct_agg)) must execute at all."""
    await _seed_latency_data(pg_session_maker)

    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=5), end=NOW + timedelta(hours=1),
        caggs=["summary_hourly_stats"],
    )

    async with pg_engine.connect() as conn:
        row = (await conn.execute(text("""
            SELECT
                approx_percentile(0.50, rollup(pct_agg)) AS p50,
                approx_percentile(0.99, rollup(pct_agg)) AS p99
            FROM summary_hourly_stats
            WHERE bucket >= :start AND bucket < :end
        """), {"start": NOW - timedelta(days=5), "end": NOW})).one()

    assert 0.005 < row.p50 < 0.02, f"p50 {row.p50} should be ~0.01"
    assert row.p99 > 0.01, "p99 must reflect the outlier's tail"


async def test_repo_summary_and_time_series_percentiles(pg_engine, pg_session_maker, clean_tables):
    """Repo reads percentiles via approx_percentile rollups on the CAGG path."""
    from geometrikks.domain.analytics.repositories import SummaryStatsRepository

    await _seed_latency_data(pg_session_maker)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=5), end=NOW + timedelta(hours=1),
    )

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        stats = await repo.get_summary(NOW - timedelta(days=3, hours=3), NOW)  # >24h -> CAGG path
        series = await repo.get_time_series(NOW - timedelta(days=3, hours=3), NOW)

    assert stats is not None and stats.p50_request_time is not None
    assert 0.005 < stats.p50_request_time < 0.02
    assert len(series) >= 3
    assert all(p.p50_request_time is not None and p.p50_request_time >= 0 for p in series)


async def test_old_shape_summary_caggs_are_upgraded(pg_engine):
    """setup_timescaledb must drop pre-percentile_agg summary CAGGs and
    recreate them with pct_agg (the alpha-install upgrade path)."""
    from geometrikks.config.settings import get_settings
    from geometrikks.server.timescale import SUMMARY_CAGGS, setup_timescaledb

    old_shape = """
        CREATE MATERIALIZED VIEW {name}
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('{bucket}', timestamp) AS bucket,
            COUNT(*) AS total_requests,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY request_time) AS p50_request_time
        FROM access_logs
        GROUP BY 1
        WITH NO DATA
    """
    async with pg_engine.begin() as conn:
        for cagg in SUMMARY_CAGGS:
            await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
        await conn.execute(text(old_shape.format(name="summary_hourly_stats", bucket="1 hour")))
        await conn.execute(text(old_shape.format(name="summary_daily_stats", bucket="1 day")))

    await setup_timescaledb(pg_engine, get_settings().analytics)

    async with pg_engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_name = ANY(:views)
        """), {"views": SUMMARY_CAGGS})
        cols = {(r.table_name, r.column_name) for r in rows}
    for view in SUMMARY_CAGGS:
        assert (view, "pct_agg") in cols
        assert (view, "p50_request_time") not in cols
