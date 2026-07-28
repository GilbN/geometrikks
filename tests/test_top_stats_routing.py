"""SummaryStatsRepository top-N routing: raw <= 24h, CAGG above, filter rules.

Uses a recording fake session: the first executed statement's SQL reveals
which path was taken (raw scans mention "FROM access_logs" outside a CTE;
CAGG reads mention the *_stats view name).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
    SummaryStatsRepository,
)

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


async def test_top_urls_short_range_goes_raw():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_urls(SHORT_START, NOW)
    assert "url_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_urls_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_urls(WEEK_START, NOW)
    assert "url_hourly_stats" in session.statements[0]


async def test_top_urls_long_range_uses_daily_cagg():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_urls(LONG_START, NOW)
    assert "url_daily_stats" in session.statements[0]


async def test_top_urls_any_filter_forces_raw():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_urls(
        WEEK_START, NOW, filters=AnalyticsFilters(country_codes=["NO"])
    )
    assert "url_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_user_agents_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_user_agents(WEEK_START, NOW)
    assert "user_agent_hourly_stats" in session.statements[0]


async def test_top_user_agents_filter_forces_raw():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_user_agents(
        WEEK_START, NOW, filters=AnalyticsFilters(ip_exclude=["1.1.1.1"])
    )
    assert "user_agent_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_ips_short_range_goes_raw():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_ips(SHORT_START, NOW)
    assert "log_ip_hourly_stats" not in session.statements[0]
    assert "FROM access_logs" in session.statements[0]


async def test_top_ips_week_range_uses_hourly_cagg_even_filtered():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_ips(
        WEEK_START, NOW, filters=AnalyticsFilters(country_codes=["NO"])
    )
    assert "log_ip_hourly_stats" in session.statements[0]


async def test_top_countries_long_range_uses_daily_cagg():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_countries(LONG_START, NOW)
    assert "log_ip_daily_stats" in session.statements[0]


async def test_top_cities_week_range_uses_hourly_cagg():
    session = _RecordingSession()
    await SummaryStatsRepository(session=session).get_top_cities(WEEK_START, NOW)
    assert "log_ip_hourly_stats" in session.statements[0]
