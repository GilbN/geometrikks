"""Pure-logic tests for the IP profile: bucket width, peak, SQL routing."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, cast

import pytest

from geometrikks.domain.analytics.ip_profile import (
    IpProfile,
    IpProfileBucket,
    IpProfileRepository,
    profile_bucket_width,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)


def test_bucket_width_is_hourly_up_to_seven_days():
    assert profile_bucket_width(NOW - timedelta(days=7), NOW) == "hourly"


def test_bucket_width_is_daily_above_seven_days():
    assert profile_bucket_width(NOW - timedelta(days=7, hours=1), NOW) == "daily"


def test_peak_is_none_for_empty_series():
    assert IpProfile().peak is None


def test_peak_is_the_first_highest_bucket():
    series = [
        IpProfileBucket(NOW - timedelta(hours=3), hits=5, error_hits=0),
        IpProfileBucket(NOW - timedelta(hours=2), hits=9, error_hits=1),
        IpProfileBucket(NOW - timedelta(hours=1), hits=9, error_hits=0),
    ]
    assert IpProfile(series=series).peak == series[1]


class _Row:
    def __init__(self, **values):
        self.__dict__.update(values)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def one(self):
        return self._rows[0]

    def one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalar_one(self):
        return self._rows[0]

    def fetchall(self):
        return self._rows


class _RecordingSession:
    """Answers the totals statement with zero rows and records every SQL."""

    def __init__(self):
        self.statements: list[str] = []

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.statements.append(sql)
        if "COUNT(DISTINCT url)" in sql:
            return _Result([_Row(
                total_requests=0, status_2xx=0, status_3xx=0, status_4xx=0, status_5xx=0,
                total_bytes=0, timed_requests=0, avg_request_time=None, p95_request_time=None,
                first_seen=None, last_seen=None, distinct_paths=0,
            )])
        if "access_log_debug" in sql:
            return _Result([3])
        return _Result([])


async def test_empty_ip_stops_after_totals_and_malformed():
    session = _RecordingSession()
    profile = await IpProfileRepository(cast("AsyncSession", session)).get_profile(
        "10.0.0.1", NOW - timedelta(hours=6), NOW
    )
    assert profile.total_requests == 0
    assert profile.malformed_requests == 3
    assert profile.series == [] and profile.hosts == [] and profile.paths == []
    assert len(session.statements) == 2


async def test_every_statement_binds_the_ip_as_inet():
    session = _RecordingSession()
    await IpProfileRepository(cast("AsyncSession", session)).get_profile(
        "10.0.0.1", NOW - timedelta(hours=6), NOW
    )
    for sql in session.statements:
        assert "CAST(:ip AS inet)" in sql
