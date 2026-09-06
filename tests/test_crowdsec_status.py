"""/crowdsec/status must say whether live updates (the poller) are running."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.security.controllers import CrowdSecController
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.crowdsec import CrowdSecService
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio


class StubCrowdSecService(CrowdSecService):
    def __init__(self) -> None:
        pass

    async def ping(self) -> bool:
        return True


def make_app(*, with_poller: bool) -> Litestar:
    async def startup(app: Litestar) -> None:
        app.state.crowdsec_service = StubCrowdSecService()
        poller = MagicMock(lapi_reachable=True) if with_poller else None
        app.state.crowdsec_stream_poller = poller

    return Litestar(
        route_handlers=[create_api_v1_router([CrowdSecController])],
        on_startup=[startup],
        dependencies={
            **ambient_settings_dependency(),
            "db_session": Provide(lambda: None, sync_to_thread=False),
        },
    )


async def test_status_reports_live_updates_when_poller_exists():
    async with AsyncTestClient(app=make_app(with_poller=True)) as client:
        body = (await client.get("/api/v1/crowdsec/status")).json()
    assert body["enabled"] is True
    assert body["liveUpdates"] is True


async def test_status_reports_live_updates_paused_without_poller():
    """DB-degraded mode defers the poller; the LAPI can still be reachable."""
    async with AsyncTestClient(app=make_app(with_poller=False)) as client:
        body = (await client.get("/api/v1/crowdsec/status")).json()
    assert body["lapiReachable"] is True
    assert body["liveUpdates"] is False
