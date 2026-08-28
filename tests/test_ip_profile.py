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


from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.analytics.asn_classification import classify_asn
from geometrikks.domain.analytics.controllers import AnalyticsController, _to_ip_profile_response
from geometrikks.domain.analytics.ip_profile import IpProfileHost, IpProfilePath, IpProfileUserAgent
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency

START = NOW - timedelta(hours=6)


def test_mapper_zero_profile_has_no_peak_and_no_category():
    resp = _to_ip_profile_response("10.0.0.1", START, NOW, IpProfile())
    assert resp.ip_address == "10.0.0.1"
    assert resp.total_requests == 0
    assert resp.peak is None
    assert resp.asn_category is None
    assert resp.series == [] and resp.hosts == []
    assert resp.error_rate == 0.0


def test_mapper_classifies_asn_and_derives_error_rate():
    profile = IpProfile(
        total_requests=10, status_2xx=2, status_4xx=7, status_5xx=1,
        asn=16509, asn_organization="Amazon",
        series=[IpProfileBucket(NOW - timedelta(hours=1), hits=10, error_hits=8)],
        hosts=[IpProfileHost(host=None, hits=10, error_hits=8)],
        paths=[IpProfilePath(url="/.env", hits=10, error_hits=8)],
        user_agents=[IpProfileUserAgent(user_agent="curl/8.0", hits=10)],
    )
    resp = _to_ip_profile_response("10.0.0.1", START, NOW, profile)
    assert resp.asn_category == classify_asn(16509)
    assert resp.error_rate == 0.8
    assert resp.peak is not None and resp.peak.hits == 10
    assert resp.hosts[0].host is None
    assert resp.granularity == "hourly"


class _FakeIpProfileRepo(IpProfileRepository):
    def __init__(self, profile: IpProfile) -> None:
        self.profile = profile
        self.calls: list[tuple[str, datetime, datetime]] = []

    async def get_profile(self, ip: str, start: datetime, end: datetime) -> IpProfile:
        self.calls.append((ip, start, end))
        return self.profile


def _app(repo: _FakeIpProfileRepo) -> Litestar:
    class _TestController(AnalyticsController):
        dependencies = {
            **AnalyticsController.dependencies,
            "ip_profile_repo": Provide(lambda: repo, sync_to_thread=False),
        }

    return Litestar(
        route_handlers=[create_api_v1_router([_TestController])],
        dependencies={
            **ambient_settings_dependency(),
            # The other analytics providers need a session; nothing here calls them.
            "db_session": Provide(lambda: None, sync_to_thread=False),
        },
        exception_handlers=EXCEPTION_HANDLERS,
    )


async def test_endpoint_rejects_non_ip():
    async with AsyncTestClient(app=_app(_FakeIpProfileRepo(IpProfile()))) as client:
        resp = await client.get(
            "/api/v1/analytics/ip-profile",
            params={"ipAddress": "not-an-ip", "startDate": START.isoformat(), "endDate": NOW.isoformat()},
        )
    assert resp.status_code == 400


async def test_endpoint_uses_camel_wire_names():
    repo = _FakeIpProfileRepo(IpProfile(total_requests=3, status_4xx=3, malformed_requests=1))
    async with AsyncTestClient(app=_app(repo)) as client:
        resp = await client.get(
            "/api/v1/analytics/ip-profile",
            params={"ipAddress": "10.0.0.1", "startDate": START.isoformat(), "endDate": NOW.isoformat()},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ipAddress"] == "10.0.0.1"
    assert body["status4xx"] == 3
    assert body["malformedRequests"] == 1
    assert body["peak"] is None
    assert body["userAgents"] == []
    assert repo.calls[0][0] == "10.0.0.1"
