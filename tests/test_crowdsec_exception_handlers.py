"""CrowdSec domain exceptions translate to clean HTTP responses."""
from __future__ import annotations

from litestar import Litestar, get
from litestar.testing import AsyncTestClient

from geometrikks.server.exceptions import CROWDSEC_EXCEPTION_HANDLERS
from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError

import pytest

pytestmark = pytest.mark.anyio


@get("/boom-unavailable")
async def raise_unavailable() -> None:
    raise CrowdSecUnavailableError("LAPI unreachable: connect timeout to 10.0.0.5")


@get("/boom-auth")
async def raise_auth() -> None:
    raise CrowdSecAuthError("LAPI rejected the bouncer API key")


def make_app() -> Litestar:
    return Litestar(
        route_handlers=[raise_unavailable, raise_auth],
        exception_handlers=CROWDSEC_EXCEPTION_HANDLERS,
    )


async def test_unavailable_maps_to_502():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/boom-unavailable")
    assert resp.status_code == 502
    assert resp.json()["detail"] == "CrowdSec LAPI is unreachable"


async def test_auth_error_maps_to_500_without_upstream_detail():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/boom-auth")
    assert resp.status_code == 500
    assert resp.json()["detail"] == (
        "CrowdSec credentials rejected; check CROWDSEC_* settings"
    )


async def test_upstream_message_is_not_echoed():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/boom-unavailable")
    assert "10.0.0.5" not in resp.text


def test_handlers_registered_on_app(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError

    app = create_app()
    assert CrowdSecUnavailableError in app.exception_handlers
    assert CrowdSecAuthError in app.exception_handlers
