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


async def test_site_home_job_updates_app_state_and_clears_the_advisory(
    monkeypatch,
):
    from types import SimpleNamespace

    from geometrikks.config.settings import MapSettings, Settings
    from geometrikks.lib.advisories import MAP_HOME_UNDETECTED
    from geometrikks.server import runtime
    from geometrikks.services.geoip import home as home_mod
    from geometrikks.services.geoip import site_homes

    resolved = home_mod.HomeLocation(
        latitude=59.9, longitude=10.7, source="external_ip"
    )
    monkeypatch.setattr(
        home_mod, "resolve_home_location", AsyncMock(return_value=resolved)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(site_homes, "upsert_auto_homes", upsert)

    settings = Settings(map=MapSettings(auto_detect_home=True, _env_file=None))
    app = SimpleNamespace(state=SimpleNamespace(map_home_location=None))
    runtime.get_advisories(cast("Any", app)).set(MAP_HOME_UNDETECTED)

    await sched.refresh_site_home_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.map_home_location is resolved
    assert runtime.get_advisories(cast("Any", app)).snapshot() == []
    upsert.assert_awaited_once()


async def test_site_home_job_updates_a_ui_head_without_writing_the_database(
    monkeypatch,
):
    from types import SimpleNamespace

    from geometrikks.config.settings import LogParserSettings, MapSettings, Settings
    from geometrikks.lib.advisories import MAP_HOME_UNDETECTED
    from geometrikks.server import runtime
    from geometrikks.services.geoip import home as home_mod
    from geometrikks.services.geoip import site_homes

    resolved = home_mod.HomeLocation(
        latitude=59.9, longitude=10.7, source="external_ip"
    )
    monkeypatch.setattr(
        home_mod, "resolve_home_location", AsyncMock(return_value=resolved)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(site_homes, "upsert_auto_homes", upsert)

    settings = Settings(
        logparser=LogParserSettings(enabled=False, _env_file=None),
        map=MapSettings(auto_detect_home=True, _env_file=None),
    )
    app = SimpleNamespace(state=SimpleNamespace(map_home_location=None))
    runtime.get_advisories(cast("Any", app)).set(MAP_HOME_UNDETECTED)

    await sched.refresh_site_home_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.map_home_location is resolved
    assert runtime.get_advisories(cast("Any", app)).snapshot() == []
    upsert.assert_not_awaited()


async def test_site_home_job_keeps_state_when_detection_fails(monkeypatch):
    from types import SimpleNamespace

    from geometrikks.config.settings import MapSettings, Settings
    from geometrikks.services.geoip import home as home_mod
    from geometrikks.services.geoip import site_homes

    previous = home_mod.HomeLocation(
        latitude=1.0, longitude=2.0, source="external_ip"
    )
    monkeypatch.setattr(
        home_mod, "resolve_home_location", AsyncMock(return_value=None)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(site_homes, "upsert_auto_homes", upsert)

    settings = Settings(map=MapSettings(auto_detect_home=True, _env_file=None))
    app = SimpleNamespace(state=SimpleNamespace(map_home_location=previous))

    await sched.refresh_site_home_job(
        cast("Any", object()), settings, cast("Any", app)
    )

    assert app.state.map_home_location is previous
    upsert.assert_awaited_once()
