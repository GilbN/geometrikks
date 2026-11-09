"""Dashboard availability and freshness without external services."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import cast


import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import CrowdSecSettings, LogParserSettings, Settings
from geometrikks.domain.analytics.repositories import SummaryStatsRepository
from geometrikks.domain.instances.views import HeadIdentityView, InstancesResponse
from geometrikks.domain.integrations.controllers import IntegrationController
from geometrikks.domain.integrations.services import IntegrationSummaryService
from geometrikks.lib.time_ranges import TimeRange
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError
from tests.test_api_key_auth import bearer, create_key
from tests.test_auth_endpoints import make_app

pytestmark = pytest.mark.anyio
NOW = datetime(2026, 11, 3, 12, tzinfo=UTC)
RANGE = TimeRange(NOW - timedelta(hours=24), NOW)


class TrafficReader:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    async def get_summary(self, start, end):
        self.calls.append((start, end))
        if self.error:
            raise self.error
        return None

    async def latest_event_at(self, start, end):
        return None


class Session:
    def __init__(self, error=None):
        self.rollbacks = 0
        self.error = error

    async def rollback(self):
        self.rollbacks += 1
        if self.error:
            raise self.error


class CrowdSec:
    def __init__(self, error=None):
        self.error = error

    async def get_decisions(self):
        if self.error:
            raise self.error
        return [object(), object()]


def service(*, traffic=None, session=None, instance_error=None, crowdsec=None, db_available=True, ingestion=None):
    app = Litestar()
    app.state.db_available = db_available
    app.state.ingestion_service = ingestion
    app.state.crowdsec_service = crowdsec
    settings = Settings(auth_disabled=True, crowdsec=CrowdSecSettings(lapi_url="http://unused.invalid", bouncer_api_key="key"))

    async def instances():
        if instance_error:
            raise instance_error
        return InstancesResponse(
            head=HeadIdentityView(instance_name="head", app_version="test", schema_revision="test"),
            instances=[], checked_at=NOW,
        )

    return IntegrationSummaryService(
        app=app, settings=settings, session=cast(AsyncSession, session or Session()),
        traffic_repo=cast(SummaryStatsRepository, traffic or TrafficReader()), instance_reader=instances,
    )


async def test_no_traffic_is_available_zero_with_unknown_latency():
    result = await service().summary(RANGE)
    assert result.traffic.available
    assert result.traffic.data.totals.total_requests == 0
    assert result.traffic.data.totals.avg_request_time is None
    assert result.traffic.data.latest_event_at is None
    assert result.instances.available
    assert result.instances.data.total == 0
    assert result.start_date == RANGE.start and result.end_date == RANGE.end


async def test_traffic_outage_rolls_back_before_reading_instances():
    session = Session()
    result = await service(traffic=TrafficReader(OSError("offline")), session=session, crowdsec=CrowdSec()).summary(RANGE)
    assert not result.traffic.available
    assert result.traffic.reason == "database_unavailable" and result.traffic.data is None
    assert session.rollbacks == 1
    assert result.instances.available
    assert result.crowdsec.data.active_decisions == 2


async def test_failed_rollback_skips_other_database_sections():
    result = await service(
        traffic=TrafficReader(OSError("offline")), session=Session(OSError("offline")), crowdsec=CrowdSec(),
    ).summary(RANGE)
    assert not result.traffic.available and not result.instances.available
    assert result.crowdsec.available


async def test_instance_failure_preserves_traffic_and_security():
    result = await service(instance_error=OSError("offline"), crowdsec=CrowdSec()).summary(RANGE)
    assert result.traffic.available
    assert not result.instances.available and result.instances.data is None
    assert result.crowdsec.available


async def test_degraded_database_does_not_attempt_traffic_queries():
    traffic = TrafficReader()
    result = await service(traffic=traffic, db_available=False, crowdsec=CrowdSec()).summary(RANGE)
    assert traffic.calls == []
    assert not result.traffic.available and not result.instances.available
    assert result.traffic.reason == result.instances.reason == "services_inactive"
    assert result.crowdsec.available


@pytest.mark.parametrize("section", ["traffic", "instances"])
@pytest.mark.parametrize("invalidated", [True, False])
async def test_invalidated_database_connections_are_section_outages(section, invalidated):
    from sqlalchemy.exc import DBAPIError

    error = DBAPIError("SELECT", {}, Exception("connection lost"), connection_invalidated=invalidated)
    reader = service(
        traffic=TrafficReader(error if section == "traffic" else None),
        instance_error=error if section == "instances" else None, crowdsec=CrowdSec(),
    )
    if not invalidated:
        with pytest.raises(DBAPIError):
            await reader.summary(RANGE)
        return
    result = await reader.summary(RANGE)
    failed = getattr(result, section)
    assert failed.reason == "database_unavailable" and failed.data is None
    assert result.crowdsec.available
    assert reader.session.rollbacks == 1


@pytest.mark.parametrize(("error", "reason"), [
    (CrowdSecUnavailableError("offline"), "crowdsec_unreachable"),
    (CrowdSecAuthError("denied"), "crowdsec_credentials_rejected"),
    (ValueError("invalid upstream JSON"), "invalid_response"),
])
async def test_security_failures_never_become_zero_decisions(error, reason):
    result = await service(crowdsec=CrowdSec(error)).summary(RANGE)
    assert result.traffic.available and result.instances.available
    assert not result.crowdsec.available
    assert result.crowdsec.reason == reason and result.crowdsec.data is None


async def test_stalled_crowdsec_is_bounded(monkeypatch):
    from geometrikks.domain.integrations import services

    class StalledCrowdSec:
        async def get_decisions(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(services, "CROWDSEC_TIMEOUT", 0.01)
    result = await service(crowdsec=StalledCrowdSec()).summary(RANGE)
    assert result.crowdsec.reason == "crowdsec_timeout"
    assert result.traffic.available


async def test_stalled_traffic_is_cancelled_before_other_sections(monkeypatch):
    from geometrikks.domain.integrations import services

    class StalledTraffic(TrafficReader):
        async def get_summary(self, start, end):
            await asyncio.Event().wait()

    monkeypatch.setattr(services, "DATABASE_SECTION_TIMEOUT", 0.01)
    session = Session()
    result = await service(traffic=StalledTraffic(), session=session, crowdsec=CrowdSec()).summary(RANGE)
    assert not result.traffic.available
    assert session.rollbacks == 1
    assert result.instances.available and result.crowdsec.available


async def test_zero_decisions_are_available_data():
    class EmptyCrowdSec:
        async def get_decisions(self):
            return []

    result = await service(crowdsec=EmptyCrowdSec()).summary(RANGE)
    assert result.crowdsec.available
    assert result.crowdsec.data.active_decisions == 0


async def test_disabled_features_are_explicit():
    reader = service()
    reader.settings.crowdsec = CrowdSecSettings()
    reader.settings.logparser = LogParserSettings(enabled=False)
    result = await reader.summary(RANGE)
    assert result.crowdsec.reason == "disabled" and result.crowdsec.data is None
    assert result.ingestion.reason == "disabled" and result.ingestion.data is None


async def test_local_parser_freshness_is_separate_from_database_event_time():
    ingestion = SimpleNamespace(
        is_running=True, unavailable_sources=[], last_record_at=NOW, parsed_lines=5,
        pending_records=2, publish_dropped=0, failed_batches=0, failed_records=0,
    )
    result = await service(ingestion=ingestion).summary(RANGE)
    assert result.ingestion.available
    assert result.ingestion.data.last_record_at == NOW.isoformat()
    assert result.traffic.data.latest_event_at is None


async def test_instance_counts_and_freshness_use_existing_evaluations():
    from geometrikks.domain.instances.views import InstanceView
    from geometrikks.domain.system.controllers.health import build_health_response

    reader = service()
    health = build_health_response(reader.app, reader.settings, None, db_reachable=True)
    parsed_at = (NOW - timedelta(minutes=10)).isoformat()
    health.ingestion.last_record_at = parsed_at
    instance = InstanceView(
        instance_name="remote-agent", mode="agent", app_version="test", schema_revision="test", boot_id="test",
        started_at=NOW - timedelta(days=1), last_seen=NOW - timedelta(minutes=5), is_self=False,
        checking_in=False, status="critical", problems=[], payload=None, health=health, server_locations=[],
    )

    async def instances():
        return InstancesResponse(
            head=HeadIdentityView(instance_name="head", app_version="test", schema_revision="test"),
            instances=[instance], checked_at=NOW,
        )

    reader.instance_reader = instances
    result = await reader.summary(RANGE)
    assert result.instances.data.total == 1
    assert result.instances.data.critical == 1 and result.instances.data.checking_in == 0
    assert result.instances.data.items[0].last_parsed_at == parsed_at
    assert result.instances.data.checked_at == NOW


async def test_read_key_can_get_default_summary_and_empty_window_is_rejected():
    reader = service()

    class TestController(IntegrationController):
        dependencies = {"summary_service": Provide(lambda: reader, sync_to_thread=False)}

    app = make_app(extra_handlers=[create_api_v1_router([TestController])])
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app)
        anonymous = await client.get("/api/v1/integration/summary")
        response = await client.get("/api/v1/integration/summary", headers=bearer(key))
        invalid = await client.get("/api/v1/integration/summary", headers=bearer(key), params={"window": ""})
    assert anonymous.status_code == 401
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert datetime.fromisoformat(body["endDate"]) - datetime.fromisoformat(body["startDate"]) == timedelta(hours=24)
    assert body["traffic"]["data"]["totals"]["totalRequests"] == 0
    assert body["crowdsec"]["data"] is None
    assert invalid.status_code == 400 and invalid.json()["code"] == "invalid_range"
