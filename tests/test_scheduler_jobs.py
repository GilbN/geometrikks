"""Scheduled job bodies raise on failure so the run tracker records it."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server import scheduler as sched
from geometrikks.server.timescale import ALL_CAGGS

pytestmark = pytest.mark.anyio


def _session_factory(session: Any):
    @asynccontextmanager
    async def _ctx():
        yield session

    return lambda: _ctx()


async def test_refresh_all_caggs_tries_every_cagg_then_raises(monkeypatch):
    called: list[str] = []

    async def fake_call(session_factory, sql: str, *args):
        name = sql.split("'")[1]
        called.append(name)
        if name == ALL_CAGGS[1]:
            raise RuntimeError("lock timeout")

    monkeypatch.setattr(sched, "_execute_call_outside_transaction", fake_call)

    message = (
        rf"1 of {len(ALL_CAGGS)} aggregates failed to refresh: {ALL_CAGGS[1]}"
    )
    with pytest.raises(RuntimeError, match=message):
        await sched.refresh_all_caggs_job(cast("Any", object()))

    assert called == list(ALL_CAGGS)


async def test_refresh_all_caggs_succeeds_quietly(monkeypatch):
    called: list[str] = []

    async def fake_call(session_factory, sql: str, *args):
        called.append(sql.split("'")[1])

    monkeypatch.setattr(sched, "_execute_call_outside_transaction", fake_call)

    await sched.refresh_all_caggs_job(cast("Any", object()))

    assert called == list(ALL_CAGGS)


async def test_location_refresh_job_propagates_service_failure(monkeypatch):
    from geometrikks.services.aggregation import service as agg

    session = MagicMock()
    session.commit = AsyncMock()
    failing = MagicMock()
    failing.refresh_location_last_hits = AsyncMock(
        side_effect=RuntimeError("deadlock")
    )
    monkeypatch.setattr(agg, "AggregationService", MagicMock(return_value=failing))

    with pytest.raises(RuntimeError, match="deadlock"):
        await sched.refresh_location_last_hits_job(_session_factory(session))

    session.commit.assert_not_awaited()


async def test_refresh_location_last_hits_reraises_after_logging():
    from geometrikks.services.aggregation.service import AggregationService

    session = MagicMock()
    session.execute = AsyncMock(side_effect=RuntimeError("deadlock"))

    with pytest.raises(RuntimeError, match="deadlock"):
        await AggregationService(session=session).refresh_location_last_hits()


async def test_server_location_job_updates_app_state_and_clears_the_advisory(
    monkeypatch,
):
    from types import SimpleNamespace

    from geometrikks.config.settings import MapSettings, Settings
    from geometrikks.lib.advisories import SERVER_LOCATION_UNDETECTED
    from geometrikks.server import runtime
    from geometrikks.services.geoip import self_location
    from geometrikks.services.geoip import server_locations

    resolved = self_location.SelfLocation(
        latitude=59.9, longitude=10.7, source="external_ip"
    )
    monkeypatch.setattr(
        self_location, "resolve_self_location", AsyncMock(return_value=resolved)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(server_locations, "upsert_auto_server_locations", upsert)

    settings = Settings(map=MapSettings(auto_detect_server_location=True, _env_file=None))
    app = SimpleNamespace(state=SimpleNamespace(self_location=None))
    runtime.get_advisories(cast("Any", app)).set(SERVER_LOCATION_UNDETECTED)

    await sched.refresh_server_location_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.self_location is resolved
    assert runtime.get_advisories(cast("Any", app)).snapshot() == []
    upsert.assert_awaited_once()


async def test_server_location_job_updates_a_ui_head_without_writing_the_database(
    monkeypatch,
):
    from types import SimpleNamespace

    from geometrikks.config.settings import LogParserSettings, MapSettings, Settings
    from geometrikks.lib.advisories import SERVER_LOCATION_UNDETECTED
    from geometrikks.server import runtime
    from geometrikks.services.geoip import self_location
    from geometrikks.services.geoip import server_locations

    resolved = self_location.SelfLocation(
        latitude=59.9, longitude=10.7, source="external_ip"
    )
    monkeypatch.setattr(
        self_location, "resolve_self_location", AsyncMock(return_value=resolved)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(server_locations, "upsert_auto_server_locations", upsert)

    settings = Settings(
        logparser=LogParserSettings(enabled=False, _env_file=None),
        map=MapSettings(auto_detect_server_location=True, _env_file=None),
    )
    app = SimpleNamespace(state=SimpleNamespace(self_location=None))
    runtime.get_advisories(cast("Any", app)).set(SERVER_LOCATION_UNDETECTED)

    await sched.refresh_server_location_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.self_location is resolved
    assert runtime.get_advisories(cast("Any", app)).snapshot() == []
    upsert.assert_not_awaited()


async def test_server_location_job_keeps_state_when_detection_fails(monkeypatch):
    from types import SimpleNamespace

    from geometrikks.config.settings import MapSettings, Settings
    from geometrikks.services.geoip import self_location
    from geometrikks.services.geoip import server_locations

    previous = self_location.SelfLocation(
        latitude=1.0, longitude=2.0, source="external_ip"
    )
    monkeypatch.setattr(
        self_location, "resolve_self_location", AsyncMock(return_value=None)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(server_locations, "upsert_auto_server_locations", upsert)

    settings = Settings(map=MapSettings(auto_detect_server_location=True, _env_file=None))
    app = SimpleNamespace(state=SimpleNamespace(self_location=previous))

    await sched.refresh_server_location_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.self_location is previous
    upsert.assert_awaited_once()


async def test_server_location_job_is_registered_under_its_id_and_name():
    from geometrikks.config.settings import LogParserSettings, SchedulerSettings, Settings

    settings = Settings(
        scheduler=SchedulerSettings(enabled=True, _env_file=None),
        logparser=LogParserSettings(enabled=True, _env_file=None),
    )
    scheduler = await sched.create_scheduler(MagicMock(), settings)
    job = scheduler.get_job("server-location-refresh")

    assert job is not None
    assert job.func is sched.refresh_server_location_job
    assert job.name == "Re-detect this server's location"
    assert scheduler.get_job("site-home-refresh") is None


async def test_agent_health_check_registered_for_head_only():
    from geometrikks.config.settings import SchedulerSettings, Settings

    settings = Settings(scheduler=SchedulerSettings(enabled=True, _env_file=None))
    head_scheduler = await sched.create_scheduler(MagicMock(), settings, mode="full", app=MagicMock())
    agent_scheduler = await sched.create_scheduler(MagicMock(), settings, mode="agent", app=MagicMock())

    job = head_scheduler.get_job("agent-health-check")
    assert job is not None
    assert job.func is sched.agent_health_check_job
    assert job.name == "Check agent heartbeats"
    assert job.max_instances == 1
    assert agent_scheduler.get_job("agent-health-check") is None


async def test_agent_health_check_job_feeds_the_monitor(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from uuid import uuid4

    from structlog.testing import capture_logs

    from geometrikks.domain.instances import repositories, services
    from geometrikks.domain.instances.evaluation import HeadIdentity
    from geometrikks.domain.instances.models import InstanceHeartbeat
    from geometrikks.domain.instances.monitor import InstanceMonitor

    now = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
    head = HeadIdentity(
        boot_id=uuid4(),
        instance_name="head",
        app_version="0.20.0",
        schema_revision="7c1e9a",
        known_revisions=frozenset({"7c1e9a"}),
    )
    stale_agent = InstanceHeartbeat(
        instance_name="edge",
        boot_id=uuid4(),
        mode="agent",
        app_version="0.20.0",
        schema_revision="7c1e9a",
        started_at=now - timedelta(hours=1),
        last_seen=now - timedelta(minutes=10),
        payload={},
    )
    monkeypatch.setattr(services, "head_identity", lambda app, settings: head)
    monkeypatch.setattr(repositories, "fetch_heartbeats", AsyncMock(return_value=[stale_agent]))
    monkeypatch.setattr(repositories, "database_now", AsyncMock(return_value=now))
    app = MagicMock()
    app.state.instance_monitor = InstanceMonitor()
    app.state.instance_monitor.observe([], head)

    with capture_logs() as logs:
        await sched.agent_health_check_job(_session_factory(MagicMock()), app)

    assert [log["event"] for log in logs] == ["agent_seen", "agent_down"]
