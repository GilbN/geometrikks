"""Startup must attempt the GeoIP ensure and record availability in app state."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock


def _patch_startup_collaborators(monkeypatch, lc, *, db_available: bool, ensure: AsyncMock):
    async def fake_db_available(timeout: float = 10.0) -> bool:
        return db_available

    sqlalchemy_config = MagicMock()
    sqlalchemy_config.get_engine.return_value = MagicMock()
    sqlalchemy_config.create_session_maker.return_value = MagicMock()

    ingestion = MagicMock()
    ingestion.start = AsyncMock()

    monkeypatch.setattr(lc, "_db_available", fake_db_available)
    monkeypatch.setattr(lc, "get_sqlalchemy_config", lambda: sqlalchemy_config)
    monkeypatch.setattr(lc, "migrate_database", AsyncMock())
    monkeypatch.setattr(lc, "setup_timescaledb", AsyncMock())
    monkeypatch.setattr(lc, "ensure_geoip_database", ensure)
    monkeypatch.setattr(lc, "create_scheduler", AsyncMock(return_value=MagicMock()))
    monkeypatch.setattr(lc, "LogParser", MagicMock())
    monkeypatch.setattr(lc, "LogIngestionService", MagicMock(return_value=ingestion))
    return ingestion


async def test_startup_records_geoip_availability(monkeypatch):
    from geometrikks.server import lifecycle as lc

    ensure = AsyncMock(return_value=False)
    ingestion = _patch_startup_collaborators(monkeypatch, lc, db_available=True, ensure=ensure)

    app = SimpleNamespace(state=SimpleNamespace())
    await lc.on_startup(app)

    ensure.assert_awaited_once()
    assert app.state.geoip_available is False
    # ingestion still constructed and started: geo-degraded, not dead
    ingestion.start.assert_awaited_once()


async def test_startup_sets_geoip_flag_even_without_database(monkeypatch):
    """GeoIP ensure does not need the DB; the flag must be accurate in DB-degraded mode."""
    from geometrikks.server import lifecycle as lc

    ensure = AsyncMock(return_value=True)
    _patch_startup_collaborators(monkeypatch, lc, db_available=False, ensure=ensure)

    app = SimpleNamespace(state=SimpleNamespace())
    await lc.on_startup(app)

    ensure.assert_awaited_once()
    assert app.state.geoip_available is True


async def test_scheduler_has_geoip_refresh_job(monkeypatch):
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    scheduler = await create_scheduler(MagicMock(), Settings())
    job_ids = {job.id for job in scheduler.get_jobs()}
    assert "geoip-refresh" in job_ids
