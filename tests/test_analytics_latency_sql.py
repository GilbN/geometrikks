"""Latency figures skip upgraded and unanswered connections: SQL shape tests.

Pure string assertions over the statements the repositories emit. The
integration suite proves the numbers; these pin where the filter and the
fallback appear so a refactor cannot drop one silently.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from geometrikks.domain.analytics.repositories import (
    LATENCY_AVG,
    LATENCY_COUNT,
    LATENCY_MAX,
    LATENCY_PCT,
    URL_LATENCY_HITS,
    URL_LATENCY_TOTAL,
    LiveStatsRepository,
    StatsGranularity,
    SummaryStatsRepository,
    latency_col,
)
from geometrikks.server.timescale import LATENCY_FILTER

pytestmark = pytest.mark.anyio

FILTER = f"FILTER (WHERE {LATENCY_FILTER})"

NOW = datetime(2026, 8, 27, 12, tzinfo=timezone.utc)


class CaptureSession:
    """AsyncSession double that records SQL and answers with no rows."""

    def __init__(self) -> None:
        self.sql: list[str] = []

    async def execute(self, statement: Any, params: Any = None) -> Any:
        self.sql.append(str(statement))
        return SimpleNamespace(one_or_none=lambda: None, fetchall=lambda: [])


def test_latency_col_falls_back_only_when_the_count_is_null() -> None:
    assert latency_col("avg_latency", "avg_request_time") == (
        "CASE WHEN latency_requests IS NULL THEN avg_request_time ELSE avg_latency END"
    )
    assert latency_col("total_latency", "total_request_time", count="latency_hits") == (
        "CASE WHEN latency_hits IS NULL THEN total_request_time ELSE total_latency END"
    )


def test_module_expressions() -> None:
    assert LATENCY_COUNT == "COALESCE(latency_requests, timed_requests, total_requests)"
    assert LATENCY_AVG == latency_col("avg_latency", "avg_request_time")
    assert LATENCY_MAX == latency_col("max_latency", "max_request_time")
    assert LATENCY_PCT == latency_col("latency_pct_agg", "pct_agg")
    assert URL_LATENCY_HITS == "COALESCE(latency_hits, timed_hits, hits)"
    assert URL_LATENCY_TOTAL == latency_col("total_latency", "total_request_time", count="latency_hits")


async def test_cagg_summary_reads_the_latency_columns() -> None:
    session = CaptureSession()
    repo = SummaryStatsRepository(session=session)  # ty: ignore[invalid-argument-type]

    await repo._get_summary_from_cagg(NOW - timedelta(days=3), NOW, StatsGranularity.HOURLY)

    sql = session.sql[0]
    assert f"MAX({LATENCY_MAX}) AS max_request_time" in sql
    assert f"rollup({LATENCY_PCT})" in sql
    assert f"SUM({LATENCY_AVG} * {LATENCY_COUNT})" in sql
    assert f"COALESCE(SUM({LATENCY_COUNT}), 0) AS timed_requests" in sql
    assert "MAX(max_request_time)" not in sql
    assert "rollup(pct_agg)" not in sql


async def test_cagg_time_series_reads_the_latency_columns_in_both_branches() -> None:
    session = CaptureSession()
    repo = SummaryStatsRepository(session=session)  # ty: ignore[invalid-argument-type]

    await repo.get_time_series(NOW - timedelta(days=3), NOW, granularity=StatsGranularity.HOURLY)
    await repo.get_time_series(
        NOW - timedelta(days=3), NOW, granularity=StatsGranularity.DAILY, tz="Europe/Oslo"
    )

    per_bucket, local_days = session.sql
    assert f"{LATENCY_COUNT} AS timed_requests" in per_bucket
    assert f"{LATENCY_MAX} AS max_request_time" in per_bucket
    assert f"approx_percentile(0.99, {LATENCY_PCT})" in per_bucket
    assert f"MAX({LATENCY_MAX}) AS max_request_time" in local_days
    assert f"rollup({LATENCY_PCT})" in local_days
    for sql in (per_bucket, local_days):
        assert "approx_percentile(0.50, pct_agg)" not in sql
        assert "rollup(pct_agg)" not in sql


async def test_stitched_top_urls_reads_the_url_latency_columns() -> None:
    session = CaptureSession()
    repo = SummaryStatsRepository(session=session)  # ty: ignore[invalid-argument-type]

    await repo.get_top_urls(NOW - timedelta(days=3), NOW)  # > 24h, no filters: stitched path

    sql = session.sql[0]
    assert f"{URL_LATENCY_HITS} AS timed_hits" in sql
    assert f"{URL_LATENCY_TOTAL} AS total_request_time" in sql
    assert "COALESCE(s.timed_hits, s.hits)" not in sql


async def test_raw_summary_filters_every_latency_aggregate() -> None:
    for make in (
        lambda s: SummaryStatsRepository(session=s)._get_summary_from_raw,
        lambda s: LiveStatsRepository(session=s).get_summary,
    ):
        session = CaptureSession()
        await make(session)(NOW - timedelta(hours=6), NOW)
        sql = session.sql[0]
        assert sql.count(FILTER) == 6, sql  # count, avg, max, p50, p95, p99
        assert f"COUNT(request_time) {FILTER} AS timed_requests" in sql
        assert f"MAX(request_time) {FILTER} AS max_request_time" in sql
        assert f"WITHIN GROUP (ORDER BY request_time) {FILTER} AS p99_request_time" in sql
        assert "COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)" in sql


async def test_raw_time_series_filters_every_latency_aggregate() -> None:
    session = CaptureSession()
    await LiveStatsRepository(session=session).get_time_series(  # ty: ignore[invalid-argument-type]
        NOW - timedelta(hours=6), NOW, bucket_interval="1 hour"
    )
    sql = session.sql[0]
    assert sql.count(FILTER) == 6
    assert "COUNT(*) AS BIGINT) AS total_requests" in sql


async def test_raw_top_urls_filters_hits_and_average() -> None:
    session = CaptureSession()
    await LiveStatsRepository(session=session).get_top_urls(NOW - timedelta(hours=6), NOW)  # ty: ignore[invalid-argument-type]
    sql = session.sql[0]
    assert f"COUNT(request_time) {FILTER} AS BIGINT) AS timed_hits" in sql
    assert f"AVG(request_time) {FILTER} AS avg_request_time" in sql
    assert "COUNT(*) AS BIGINT) AS hits" in sql


async def test_stitched_top_urls_raw_halves_filter_the_edges() -> None:
    session = CaptureSession()
    await SummaryStatsRepository(session=session).get_top_urls(NOW - timedelta(days=3), NOW)  # ty: ignore[invalid-argument-type]
    sql = session.sql[0]
    edge = "CAST((al.request_time IS NOT NULL AND al.status_code NOT IN (0, 101))::int AS BIGINT)"
    assert sql.count(edge) == 2
    assert sql.count("CASE WHEN al.status_code NOT IN (0, 101) THEN al.request_time END") == 2
    assert "CAST((al.request_time IS NOT NULL)::int AS BIGINT)" not in sql
