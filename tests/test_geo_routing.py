"""GeoEventService summary/time-series routing: hostname forces raw,
country/city/IP filters ride the stitched ip_location CAGGs."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from geometrikks.domain.geo.repositories import StatsGranularity
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.geo.services import GeoEventService

import pytest

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
WEEK_START = NOW - timedelta(days=7)


class _Result:
    def fetchall(self):
        return []

    def one(self):
        return SimpleNamespace(
            total_events=0, unique_ips=0, unique_countries=0, unique_cities=0
        )


class _RecordingSession:
    # Minimal surface for advanced-alchemy repository construction.
    bind = SimpleNamespace(
        dialect=SimpleNamespace(name="postgresql", server_version_info=(18, 0))
    )
    info: dict = {}

    def __init__(self):
        self.statements: list[str] = []

    async def execute(self, stmt, params=None):
        self.statements.append(str(stmt))
        return _Result()


async def test_country_filtered_summary_uses_ip_location_cagg():
    session = _RecordingSession()
    await GeoEventService(session=session).get_summary(
        WEEK_START, NOW, GeoEventFilters(country_codes=["NO"])
    )
    assert "ip_location_hourly_stats" in session.statements[0]


async def test_hostname_filtered_summary_stays_raw():
    session = _RecordingSession()
    await GeoEventService(session=session).get_summary(
        WEEK_START, NOW, GeoEventFilters(hostnames=["web1"])
    )
    assert "ip_location_hourly_stats" not in session.statements[0]
    assert "FROM geo_events" in session.statements[0]


async def test_ip_filtered_time_series_uses_ip_location_cagg():
    session = _RecordingSession()
    await GeoEventService(session=session).get_time_series(
        WEEK_START, NOW, StatsGranularity.HOURLY, GeoEventFilters(ip_include=["1.1.1.1"])
    )
    assert "ip_location_hourly_stats" in session.statements[0]


async def test_unfiltered_summary_keeps_hll_cagg():
    session = _RecordingSession()
    await GeoEventService(session=session).get_summary(WEEK_START, NOW, GeoEventFilters())
    assert "geo_summary_hourly_stats" in session.statements[0]


async def test_unfiltered_short_range_time_series_goes_raw():
    session = _RecordingSession()
    await GeoEventService(session=session).get_time_series(
        NOW - timedelta(hours=6), NOW, StatsGranularity.HOURLY, GeoEventFilters()
    )
    assert "geo_summary_hourly_stats" not in session.statements[0]
    assert "FROM geo_events" in session.statements[0]


async def test_hourly_override_on_long_filtered_range_goes_raw():
    session = _RecordingSession()
    await GeoEventService(session=session).get_time_series(
        NOW - timedelta(days=90), NOW, StatsGranularity.HOURLY,
        GeoEventFilters(country_codes=["NO"]),
    )
    assert "ip_location_hourly_stats" not in session.statements[0]
    assert "FROM geo_events" in session.statements[0]


async def test_stitched_sql_binds_bounds_as_params():
    """Regression: stitch bounds must be plain bind params, never a joined CTE
    (a CTE join defeats TimescaleDB chunk exclusion on the raw legs)."""
    session = _RecordingSession()
    await GeoEventService(session=session).get_summary(
        WEEK_START, NOW, GeoEventFilters(country_codes=["NO"])
    )
    sql = session.statements[0]
    assert "bounds" not in sql
    assert ":a_start" in sql and ":a_end" in sql
