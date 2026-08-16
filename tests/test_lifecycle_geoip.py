"""Startup must attempt the GeoIP ensure and record availability in app state."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.support import enter_lifespan

pytestmark = pytest.mark.anyio


def _patch_startup_collaborators(monkeypatch, lc, *, db_available: bool, ensure: AsyncMock):
    async def fake_db_available(app, timeout: float = 10.0) -> bool:
        return db_available

    sqlalchemy_config = MagicMock()
    sqlalchemy_config.get_engine.return_value = MagicMock()
    sqlalchemy_config.create_session_maker.return_value = MagicMock()

    ingestion = MagicMock()
    ingestion.start = AsyncMock()
    ingestion.stop = AsyncMock()

    monkeypatch.setattr(lc, "_db_available", fake_db_available)
    monkeypatch.setattr(lc, "get_app_db_config", lambda app: sqlalchemy_config)
    monkeypatch.setattr(lc, "migrate_database", AsyncMock())
    monkeypatch.setattr(lc, "setup_timescaledb", AsyncMock())
    monkeypatch.setattr(lc, "ensure_geoip_database", ensure)
    resolve_home = AsyncMock(return_value=None)
    monkeypatch.setattr(lc, "resolve_home_location", resolve_home)
    monkeypatch.setattr(lc, "create_scheduler", AsyncMock(return_value=MagicMock()))
    monkeypatch.setattr(lc, "LogParser", MagicMock())
    monkeypatch.setattr(lc, "LogIngestionService", MagicMock(return_value=ingestion))
    return ingestion, resolve_home


async def test_startup_records_geoip_availability(monkeypatch):
    from geometrikks.server import lifecycle as lc

    ensure = AsyncMock(return_value=False)
    ingestion, resolve_home = _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=ensure
    )

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        pass

    ensure.assert_awaited_once()
    resolve_home.assert_awaited_once()
    assert app.state.geoip_available is False
    assert app.state.map_home_location is None
    # ingestion is still constructed and start() is still invoked (the real
    # service early-returns without a GeoLite2 reader): geo-degraded, not dead
    ingestion.start.assert_awaited_once()


async def test_startup_sets_geoip_flag_even_without_database(monkeypatch):
    """GeoIP ensure does not need the DB; the flag must be accurate in DB-degraded mode."""
    from geometrikks.server import lifecycle as lc

    ensure = AsyncMock(return_value=True)
    _, resolve_home = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=ensure
    )

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        pass

    ensure.assert_awaited_once()
    resolve_home.assert_awaited_once()
    assert app.state.geoip_available is True


async def test_scheduler_has_geoip_refresh_job(monkeypatch):
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    scheduler = await create_scheduler(MagicMock(), Settings())
    job_ids = {job.id for job in scheduler.get_jobs()}
    assert "geoip-refresh" in job_ids


async def test_scheduler_agent_mode_registers_only_geoip_refresh(monkeypatch):
    """Agent instances tail logs into a schema the primary owns: no CAGG or
    location-refresh maintenance jobs, no CrowdSec poll -- just GeoLite2 and
    the site-home refresh (on its own MAP_HOME_REFRESH_HOURS cadence)."""
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    scheduler = await create_scheduler(MagicMock(), Settings(), mode="agent")
    job_ids = {job.id for job in scheduler.get_jobs()}
    assert job_ids == {"geoip-refresh", "site-home-refresh"}


async def test_scheduler_registers_site_home_refresh_in_full_mode(monkeypatch):
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    scheduler = await create_scheduler(MagicMock(), Settings())
    job_ids = {job.id for job in scheduler.get_jobs()}
    assert "site-home-refresh" in job_ids


async def test_site_home_refresh_uses_its_own_cadence(monkeypatch):
    """The site-home refresh trigger comes from MAP_HOME_REFRESH_HOURS, not
    GEOIP_REFRESH_DAYS: the GeoLite2 database and a site's public IP change
    on unrelated schedules."""
    from datetime import timedelta

    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    monkeypatch.setenv("MAP_HOME_REFRESH_HOURS", "6")
    monkeypatch.setenv("GEOIP_REFRESH_DAYS", "3")
    scheduler = await create_scheduler(MagicMock(), Settings())
    job = scheduler.get_job("site-home-refresh")
    assert job is not None
    assert job.trigger.interval == timedelta(hours=6)
