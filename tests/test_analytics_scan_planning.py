"""Wide analytics scans ask the planner for parallel workers first.

SQL-order tests over a capturing session. The repository has to issue the
planner settings in the scan's transaction, before the scan.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
    LiveStatsRepository,
    SummaryStatsRepository,
)

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 8, 27, 12, tzinfo=timezone.utc)
HOURS_AGO = NOW - timedelta(hours=6)
DAYS_AGO = NOW - timedelta(days=3)
EXCLUDE = AnalyticsFilters(ip_exclude=["10.0.0.1"])


class CaptureSession:
    """AsyncSession double that records SQL and answers with no rows."""

    def __init__(self) -> None:
        self.sql: list[str] = []

    async def execute(self, statement: Any, params: Any = None) -> Any:
        self.sql.append(str(statement))
        return SimpleNamespace(
            one_or_none=lambda: None,
            one=lambda: SimpleNamespace(hits=0, total_bytes=0),
            fetchall=lambda: [],
        )


ScanCall = Callable[[Any], Awaitable[object]]

WIDE_SCANS: dict[str, ScanCall] = {
    "raw time series": lambda s: LiveStatsRepository(session=s).get_time_series(
        HOURS_AGO, NOW, bucket_interval="1 hour", filters=EXCLUDE
    ),
    "raw top urls": lambda s: LiveStatsRepository(session=s).get_top_urls(HOURS_AGO, NOW, filters=EXCLUDE),
    "raw top user agents": lambda s: LiveStatsRepository(session=s).get_top_user_agents(
        HOURS_AGO, NOW, filters=EXCLUDE
    ),
    "raw top asns": lambda s: LiveStatsRepository(session=s).get_top_asns(HOURS_AGO, NOW, filters=EXCLUDE),
    "raw top ips": lambda s: LiveStatsRepository(session=s).get_top_ips(HOURS_AGO, NOW, filters=EXCLUDE),
    "raw top countries": lambda s: LiveStatsRepository(session=s).get_top_countries(
        HOURS_AGO, NOW, filters=EXCLUDE
    ),
    "raw top cities": lambda s: LiveStatsRepository(session=s).get_top_cities(HOURS_AGO, NOW, filters=EXCLUDE),
    "stitched top urls": lambda s: SummaryStatsRepository(session=s).get_top_urls(DAYS_AGO, NOW),
    "filtered request totals": lambda s: SummaryStatsRepository(session=s).get_request_totals(
        DAYS_AGO, NOW, filters=EXCLUDE
    ),
}


@pytest.mark.parametrize("scan", WIDE_SCANS.values(), ids=WIDE_SCANS.keys())
async def test_wide_scans_set_the_planner_up_before_scanning(scan: ScanCall) -> None:
    session = CaptureSession()

    await scan(session)

    assert len(session.sql) == 2, session.sql
    assert "parallel_setup_cost" in session.sql[0]
    assert "access_logs" in session.sql[1]


SMALL_CAGG_READS: dict[str, ScanCall] = {
    "stitched top user agents": lambda s: SummaryStatsRepository(session=s).get_top_user_agents(DAYS_AGO, NOW),
    "stitched top asns": lambda s: SummaryStatsRepository(session=s).get_top_asns(DAYS_AGO, NOW),
    "unfiltered request totals": lambda s: SummaryStatsRepository(session=s).get_request_totals(DAYS_AGO, NOW),
}


@pytest.mark.parametrize("read", SMALL_CAGG_READS.values(), ids=SMALL_CAGG_READS.keys())
async def test_small_cagg_reads_keep_the_default_planner(read: ScanCall) -> None:
    session = CaptureSession()

    await read(session)

    assert not any("parallel_setup_cost" in sql for sql in session.sql), session.sql
