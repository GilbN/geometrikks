"""Pins the public error envelope: Litestar's native shape.

The 0.7.0 wire-format policy (docs/api-conventions.md) keeps Litestar's
native HTTP error envelope as the public error contract:

    {"status_code": <int>, "detail": <str>, "extra"?: [...]}

Envelope keys are the framework's and stay snake_case even though success
payloads are camelCase; "extra" appears only on request-validation errors.
Every error path, framework-raised or translated from a domain exception,
must produce this shape.
"""
from __future__ import annotations

import pytest
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import DatabaseSettings, Settings
from geometrikks.server.core import create_app

pytestmark = pytest.mark.anyio


def _hermetic_settings(**overrides) -> Settings:
    return Settings(
        auth_disabled=True,
        # Unroutable database -> degraded startup; no test touches a real DB.
        database=DatabaseSettings(host="127.0.0.1", port=59999),
        **overrides,
    )


async def test_unknown_api_route_is_native_404_envelope():
    app = create_app(settings=_hermetic_settings())
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    assert body["status_code"] == 404
    assert isinstance(body["detail"], str)


def test_non_api_404_keeps_empty_body():
    """Non-API 404s keep the empty-body behavior the vite plugin uses for
    static-asset misses; only API paths render the JSON envelope."""
    from litestar.exceptions import NotFoundException
    from litestar.testing import RequestFactory

    from geometrikks.server.exceptions import handle_not_found

    request = RequestFactory().get("/some/asset.js")
    response = handle_not_found(request, NotFoundException())
    assert response.status_code == 404
    assert response.content == b""


async def test_method_not_allowed_is_native_405_envelope():
    app = create_app(settings=_hermetic_settings())
    async with AsyncTestClient(app=app) as client:
        resp = await client.post("/api/v1/settings")
    assert resp.status_code == 405
    body = resp.json()
    assert body["status_code"] == 405
    assert isinstance(body["detail"], str)


async def test_request_validation_error_is_native_400_envelope():
    """Framework validation (bad datetime) fails before the handler runs."""
    app = create_app(settings=_hermetic_settings())
    async with AsyncTestClient(app=app) as client:
        resp = await client.get(
            "/api/v1/access-logs/", params={"fromTimestamp": "not-a-date"}
        )
    assert resp.status_code == 400
    body = resp.json()
    assert body["status_code"] == 400
    assert isinstance(body["detail"], str)
    # "extra" carries the per-field breakdown on validation errors only.
    assert "extra" in body


async def test_domain_validation_error_shares_the_envelope():
    """Translated DomainValidationError is indistinguishable in shape."""
    app = create_app(settings=_hermetic_settings())
    async with AsyncTestClient(app=app) as client:
        resp = await client.get(
            "/api/v1/geo-events/", params={"ipAddressIn": "not-an-ip"}
        )
    assert resp.status_code == 400
    body = resp.json()
    assert body["status_code"] == 400
    assert "Invalid IP address" in body["detail"]


async def test_unauthenticated_api_request_is_native_401_envelope():
    app = create_app(
        settings=Settings(
            admin_user="admin",
            admin_password="bestpasswordintheworldnojoke",
            database=DatabaseSettings(host="127.0.0.1", port=59999),
        )
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/settings")
    assert resp.status_code == 401
    body = resp.json()
    assert body["status_code"] == 401
    assert isinstance(body["detail"], str)
