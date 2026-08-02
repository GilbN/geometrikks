"""Lifespan startup wires the CrowdSec service into app state; exit closes it."""
from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock, MagicMock

from geometrikks.services.crowdsec import CrowdSecService
from tests.support import enter_lifespan
from tests.test_lifecycle_geoip import _patch_startup_collaborators

import pytest

if TYPE_CHECKING:
    from litestar import Litestar

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
    async with enter_lifespan(app):
        assert isinstance(app.state.crowdsec_service, CrowdSecService)


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
    async with enter_lifespan(app):
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
    async with enter_lifespan(app):
        assert isinstance(app.state.crowdsec_service, CrowdSecService)


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
    async with enter_lifespan(app):
        assert app.state.crowdsec_stream_poller is None
        assert isinstance(app.state.crowdsec_service, CrowdSecService)


async def test_crowdsec_lifespan_closes_service_on_exit(monkeypatch):
    """The manager owns its own cleanup: exit closes the LAPI client."""
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    service = AsyncMock(spec=CrowdSecService)
    monkeypatch.setattr(lc, "CrowdSecService", MagicMock(return_value=service))
    monkeypatch.setattr(lc, "CrowdSecStreamPoller", MagicMock())

    app = make_app()
    async with lc.crowdsec_lifespan(cast("Litestar", app)):
        service.aclose.assert_not_awaited()
    service.aclose.assert_awaited_once()


def test_controller_registered_in_routes(monkeypatch):
    # Assert via app.routes, not Router.routes: Litestar 3 moves route access
    # to the application object.
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app

    app = create_app()
    assert any(route.path.startswith("/api/v1/crowdsec") for route in app.routes)


async def test_startup_creates_stream_poller_when_enabled(monkeypatch):
    from geometrikks.server import lifecycle as lc
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = make_app()
    async with enter_lifespan(app):
        assert isinstance(app.state.crowdsec_stream_poller, CrowdSecStreamPoller)
        # The scheduler factory received the poller so the poll job gets registered
        create_scheduler_mock = cast("AsyncMock", lc.create_scheduler)
        create_scheduler_mock.assert_awaited_once()
        assert create_scheduler_mock.await_args is not None
        assert (
            create_scheduler_mock.await_args.kwargs["crowdsec_poller"]
            is app.state.crowdsec_stream_poller
        )
