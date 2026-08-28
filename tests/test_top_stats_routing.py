"""SummaryStatsRepository top-N routing: raw <= 24h, CAGG above, filter rules.

Uses a recording fake session: the first executed statement's SQL reveals
which path was taken (raw scans mention "FROM access_logs" outside a CTE;
CAGG reads mention the *_stats view name).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, cast

from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
    SummaryStatsRepository,
)

import pytest

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
SHORT_START = NOW - timedelta(hours=6)     # RAW routing
WEEK_START = NOW - timedelta(days=7)       # HOURLY routing
LONG_START = NOW - timedelta(days=60)      # DAILY routing


class _Result:
    def fetchall(self):
        return []


class _RecordingSession:
    def __init__(self):
        self.statements: list[str] = []

    async def execute(self, stmt, params=None):
        self.statements.append(str(stmt))
        return _Result()


def _repo(session: _RecordingSession) -> SummaryStatsRepository:
    return SummaryStatsRepository(session=cast("AsyncSession", session))


async def test_top_urls_short_range_goes_raw():
    session = _RecordingSession()
    await _repo(session).get_top_urls(SHORT_START, NOW)
    assert "url_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_urls_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_urls(WEEK_START, NOW)
    assert "url_hourly_stats" in session.statements[0]


async def test_top_urls_long_range_uses_daily_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_urls(LONG_START, NOW)
    assert "url_daily_stats" in session.statements[0]


async def test_top_urls_any_filter_forces_raw():
    session = _RecordingSession()
    await _repo(session).get_top_urls(
        WEEK_START, NOW, filters=AnalyticsFilters(country_codes=["NO"])
    )
    assert "url_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_user_agents_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_user_agents(WEEK_START, NOW)
    assert "user_agent_hourly_stats" in session.statements[0]


async def test_top_user_agents_filter_forces_raw():
    session = _RecordingSession()
    await _repo(session).get_top_user_agents(
        WEEK_START, NOW, filters=AnalyticsFilters(ip_exclude=["1.1.1.1"])
    )
    assert "user_agent_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_ips_short_range_goes_raw():
    session = _RecordingSession()
    await _repo(session).get_top_ips(SHORT_START, NOW)
    assert "log_ip_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_ips_week_range_uses_hourly_cagg_even_filtered():
    session = _RecordingSession()
    await _repo(session).get_top_ips(
        WEEK_START, NOW, filters=AnalyticsFilters(country_codes=["NO"])
    )
    assert "log_ip_hourly_stats" in session.statements[0]


async def test_top_countries_long_range_uses_daily_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_countries(LONG_START, NOW)
    assert "log_ip_daily_stats" in session.statements[0]


async def test_top_cities_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_cities(WEEK_START, NOW)
    assert "log_ip_hourly_stats" in session.statements[0]


async def test_stitched_sql_binds_bounds_as_params():
    """Regression: stitch bounds must be plain bind params, never a joined CTE.

    A bounds CTE joined into each leg turns the timestamp constraints into
    join predicates, which TimescaleDB cannot use for chunk exclusion - the
    raw legs then decompress and scan the entire hypertable (seconds instead
    of milliseconds on large databases).
    """
    session = _RecordingSession()
    await _repo(session).get_top_ips(WEEK_START, NOW)
    sql = session.statements[0]
    assert "bounds" not in sql
    assert ":a_start" in sql and ":a_end" in sql

async def test_top_asns_short_range_goes_raw():
    session = _RecordingSession()
    await _repo(session).get_top_asns(SHORT_START, NOW)
    assert "asn_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_asns_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_asns(WEEK_START, NOW)
    assert "asn_hourly_stats" in session.statements[0]


async def test_top_asns_long_range_uses_daily_cagg():
    session = _RecordingSession()
    await _repo(session).get_top_asns(LONG_START, NOW)
    assert "asn_daily_stats" in session.statements[0]


async def test_top_asns_any_filter_forces_raw():
    session = _RecordingSession()
    await _repo(session).get_top_asns(
        WEEK_START, NOW, filters=AnalyticsFilters(country_codes=["NO"])
    )
    assert "asn_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_urls_raw_groups_and_orders_by_host_then_path():
    session = _RecordingSession()
    await _repo(session).get_top_urls(SHORT_START, NOW)
    sql = session.statements[0]
    assert re.search(r"SELECT\s+host,\s+url,", sql)
    assert "GROUP BY host, url" in sql
    assert "ORDER BY hits DESC, host, url" in sql


async def test_top_urls_stitched_carries_host_through_every_arm():
    session = _RecordingSession()
    await _repo(session).get_top_urls(WEEK_START, NOW)
    sql = session.statements[0]
    assert sql.count("SELECT s.host, s.url,") == 1
    assert sql.count("SELECT al.host, al.url,") == 2
    assert "GROUP BY host, url" in sql
    assert "ORDER BY hits DESC, host, url" in sql


def test_top_url_row_round_trips_into_the_dto():
    from geometrikks.domain.analytics.dtos import TopUrlDTO
    from geometrikks.domain.analytics.repositories import TopUrlRow

    row = TopUrlRow(
        host="app.example.com", url="/graphql", hits=3, error_hits=0,
        total_bytes=10, avg_request_time=None, timed_hits=0,
    )
    dto = TopUrlDTO(**vars(row))
    assert dto.host == "app.example.com"
    assert TopUrlDTO(**vars(TopUrlRow(
        host=None, url="/", hits=1, error_hits=0, total_bytes=0,
        avg_request_time=None, timed_hits=0,
    ))).host is None
