"""Lifespan managers: teardown ordering, partial-failure unwind, degraded mode."""
from __future__ import annotations

from types import SimpleNamespace
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
    scheduler = lc.create_scheduler.return_value
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
    lc.create_scheduler.assert_not_awaited()
    lc.LogIngestionService.assert_not_called()


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
    scheduler = lc.create_scheduler.return_value
    scheduler.start = MagicMock(side_effect=RuntimeError("job store down"))
    scheduler.running = True

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="job store down"):
        async with enter_lifespan(app):
            pass

    scheduler.shutdown.assert_called_once_with(wait=True)
    lc.LogIngestionService.assert_not_called()


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

    lc.create_scheduler.assert_not_awaited()
    lc.LogIngestionService.assert_not_called()
