"""Startup wires the CrowdSec service into app state; shutdown closes it."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from geometrikks.services.crowdsec import CrowdSecService
from tests.test_lifecycle_geoip import _patch_startup_collaborators

import pytest

pytestmark = pytest.mark.anyio


def make_app() -> SimpleNamespace:
    return SimpleNamespace(state=SimpleNamespace())


async def test_startup_creates_service_when_enabled(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    await lc.on_startup(app)
    assert isinstance(app.state.crowdsec_service, CrowdSecService)
    await app.state.crowdsec_service.aclose()


async def test_startup_without_config_sets_none(monkeypatch, tmp_path):
    from geometrikks.server import lifecycle as lc

    # chdir away from the repo so a local .env with CROWDSEC_* can't leak in
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("CROWDSEC_LAPI_URL", raising=False)
    monkeypatch.delenv("CROWDSEC_BOUNCER_API_KEY", raising=False)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    await lc.on_startup(app)
    assert app.state.crowdsec_service is None


async def test_startup_creates_service_even_without_database(monkeypatch):
    """The LAPI client does not need the DB; it must exist in DB-degraded mode."""
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    await lc.on_startup(app)
    assert isinstance(app.state.crowdsec_service, CrowdSecService)
    await app.state.crowdsec_service.aclose()


async def test_startup_without_database_disables_stream_poller(monkeypatch):
    """The poll job runs on the scheduler, which never starts in DB-degraded
    mode; a live poller would leave /ws/crowdsec clients hanging instead of
    closing 1013."""
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    await lc.on_startup(app)
    assert app.state.crowdsec_stream_poller is None
    assert isinstance(app.state.crowdsec_service, CrowdSecService)
    await app.state.crowdsec_service.aclose()


async def test_shutdown_closes_service():
    from geometrikks.server import lifecycle as lc

    service = AsyncMock(spec=CrowdSecService)
    app = SimpleNamespace(state=SimpleNamespace(crowdsec_service=service))
    await lc.on_shutdown(app)
    service.aclose.assert_awaited_once()


def test_controller_registered_in_routes():
    from litestar import Router

    from geometrikks.server.routes import get_route_handlers

    handlers = get_route_handlers()
    api_router = next(h for h in handlers if isinstance(h, Router))
    assert api_router.path == "/api/v1"
    assert any(route.path.startswith("/api/v1/crowdsec") for route in api_router.routes)


async def test_startup_creates_stream_poller_when_enabled(monkeypatch):
    from geometrikks.server import lifecycle as lc
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    await lc.on_startup(app)
    assert isinstance(app.state.crowdsec_stream_poller, CrowdSecStreamPoller)
    # The scheduler factory received the poller so the poll job gets registered
    lc.create_scheduler.assert_awaited_once()
    assert (
        lc.create_scheduler.await_args.kwargs["crowdsec_poller"]
        is app.state.crowdsec_stream_poller
    )
    await app.state.crowdsec_service.aclose()
