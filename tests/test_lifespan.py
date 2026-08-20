"""Lifespan managers: teardown ordering, partial-failure unwind, degraded mode."""
from __future__ import annotations

from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.support import enter_lifespan
from tests.test_lifecycle_geoip import _patch_startup_collaborators

pytestmark = pytest.mark.anyio


def _enable_crowdsec(monkeypatch) -> None:
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")


def _patch_crowdsec_service(monkeypatch, lc) -> MagicMock:
    service = MagicMock()
    service.aclose = AsyncMock()
    monkeypatch.setattr(lc, "CrowdSecService", MagicMock(return_value=service))
    monkeypatch.setattr(lc, "CrowdSecStreamPoller", MagicMock())
    return service


async def test_teardown_runs_in_reverse_startup_order(monkeypatch):
    """Ingestion stops before the scheduler, which stops before the CrowdSec
    client closes: nothing keeps writing or polling during teardown."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    order: list[str] = []
    service = _patch_crowdsec_service(monkeypatch, lc)
    service.aclose = AsyncMock(side_effect=lambda: order.append("crowdsec"))
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.running = True
    scheduler.shutdown = MagicMock(side_effect=lambda wait=True: order.append("scheduler"))
    ingestion.stop = AsyncMock(side_effect=lambda timeout=None: order.append("ingestion"))

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        assert order == []

    assert order == ["ingestion", "scheduler", "crowdsec"]


async def test_startup_failure_unwinds_started_managers(monkeypatch):
    """A migration failure fails startup, but the CrowdSec client the earlier
    manager already opened must still be closed (partial-startup cleanup)."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    service = _patch_crowdsec_service(monkeypatch, lc)
    monkeypatch.setattr(lc, "migrate_database", AsyncMock(side_effect=RuntimeError("boom")))

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="boom"):
        async with enter_lifespan(app):
            pass  # pragma: no cover - startup fails before the body runs

    service.aclose.assert_awaited_once()
    # The failure happened before the scheduler and ingestion managers entered.
    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_crowdsec_wiring_failure_still_closes_client(monkeypatch):
    """If setup fails after the LAPI client exists (poller construction),
    the manager's own cleanup must close the client."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    service = _patch_crowdsec_service(monkeypatch, lc)
    monkeypatch.setattr(
        lc, "CrowdSecStreamPoller", MagicMock(side_effect=RuntimeError("poller boom"))
    )

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="poller boom"):
        async with enter_lifespan(app):
            pass

    service.aclose.assert_awaited_once()


async def test_scheduler_start_failure_still_shuts_down(monkeypatch):
    """If start() activates the scheduler and then raises, the running
    scheduler must still be shut down; ingestion never starts."""
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.start = MagicMock(side_effect=RuntimeError("job store down"))
    scheduler.running = True

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="job store down"):
        async with enter_lifespan(app):
            pass

    scheduler.shutdown.assert_called_once_with(wait=True)
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_ingestion_start_failure_still_stops_service(monkeypatch):
    """If start() activates tailers and then raises, the partially started
    service must still be stopped."""
    from geometrikks.server import lifecycle as lc

    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    ingestion.start = AsyncMock(side_effect=RuntimeError("tailer exploded"))

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="tailer exploded"):
        async with enter_lifespan(app):
            pass

    ingestion.stop.assert_awaited_once()


async def test_db_degraded_mode_skips_scheduler_and_ingestion(monkeypatch):
    """DB-degraded mode serves the API but never starts DB-bound services."""
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        assert app.state.db_available is False
        assert not hasattr(app.state, "scheduler")
        assert not hasattr(app.state, "ingestion_service")

    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_agent_mode_waits_for_schema_and_skips_crowdsec(monkeypatch):
    """Agent mode never migrates or manages TimescaleDB objects -- it waits
    for the primary instance's schema instead -- and never wires CrowdSec."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    wait_for_schema = AsyncMock(return_value="ready")
    monkeypatch.setattr(lc, "wait_for_schema", wait_for_schema)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    wait_for_schema.assert_awaited_once()
    cast("AsyncMock", lc.migrate_database).assert_not_awaited()
    cast("AsyncMock", lc.setup_timescaledb).assert_not_awaited()
    assert app.state.db_available is True
    assert app.state.schema_wait_result == "ready"
    assert app.state.crowdsec_service is None
    assert app.state.crowdsec_stream_poller is None


async def test_agent_mode_schema_timeout_is_db_degraded(monkeypatch):
    """A schema wait that never reaches ready/newer degrades like an
    unreachable database: no scheduler, no ingestion."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="timeout"))

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert app.state.db_available is False
        assert app.state.schema_wait_result == "timeout"

    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_ingestion_disabled_by_config_skips_construction(monkeypatch):
    """LOGPARSER_ENABLED=false no-ops ingestion without building parsers or
    the service -- mirrors the DB-degraded no-op path. /health tells
    "disabled by configuration" apart from degraded by reading
    settings.logparser.enabled directly."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_ENABLED", "false")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert not hasattr(app.state, "ingestion_service")

    cast("MagicMock", lc.LogParser).assert_not_called()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_agent_schema_ready_triggers_home_upsert(monkeypatch):
    """A successful schema wait records this agent's detected home for each
    hostname it tails."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="ready"))
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    upsert.assert_awaited_once()
    assert upsert.await_args is not None
    hostnames = upsert.await_args.args[1]
    assert hostnames == Settings().logparser.resolved_hostnames()


async def test_agent_schema_timeout_skips_home_upsert(monkeypatch):
    """A timed-out schema wait leaves site_homes untouched: the agent is
    already going degraded, there is nothing trustworthy to record."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="timeout"))
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    upsert.assert_not_awaited()


async def test_full_startup_reconciles_overrides_and_upserts(monkeypatch):
    """A primary instance always reconciles MAP_HOME_LOCATIONS overrides and,
    when it also tails logs, records its own auto-detected home."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    reconcile = AsyncMock()
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "reconcile_override_homes", reconcile)
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    reconcile.assert_awaited_once()
    upsert.assert_awaited_once()


async def test_ui_head_reconciles_but_does_not_upsert(monkeypatch):
    """LOGPARSER_ENABLED=false tails nothing under its own hostname, so it
    still reconciles overrides but skips the auto upsert."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_ENABLED", "false")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    reconcile = AsyncMock()
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "reconcile_override_homes", reconcile)
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    reconcile.assert_awaited_once()
    upsert.assert_not_awaited()


async def test_full_startup_site_home_failure_does_not_block_startup(monkeypatch):
    """Site homes are presentation data: a write failure logs a warning and
    startup still reaches a healthy, DB-available state."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        lc, "reconcile_override_homes", AsyncMock(side_effect=RuntimeError("db boom"))
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert app.state.db_available is True


async def test_ingestion_wires_per_file_hostnames(monkeypatch):
    """Each tailed file's parser gets its positional hostname; the service
    fallback gets the first resolved hostname."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log"]')
    monkeypatch.setenv("LOGPARSER_HOST_NAME", '["vps-1", "vps-2"]')
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    hostnames = [
        call.kwargs["hostname"] for call in cast("MagicMock", lc.LogParser).call_args_list
    ]
    assert hostnames == ["vps-1", "vps-2"]
    assert cast("MagicMock", lc.LogIngestionService).call_args.kwargs["hostname"] == "vps-1"
