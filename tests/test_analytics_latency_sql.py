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
    StatsGranularity,
    SummaryStatsRepository,
    latency_col,
)

pytestmark = pytest.mark.anyio

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
