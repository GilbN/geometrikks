"""API error codes alongside status, detail and validation extra."""
from __future__ import annotations

import pytest
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import DatabaseSettings, Settings
from geometrikks.server.core import create_app
from tests.refused_port import refused_port

pytestmark = pytest.mark.anyio


def _hermetic_settings(**overrides) -> Settings:
    return Settings(
        auth_disabled=True,
        # Refused database -> degraded startup; no test touches a real DB.
        database=DatabaseSettings(host="127.0.0.1", port=refused_port()),
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
    assert isinstance(body["code"], str)


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
    assert isinstance(body["code"], str)


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
    assert isinstance(body["code"], str)
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
            database=DatabaseSettings(host="127.0.0.1", port=refused_port()),
        )
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/settings")
    assert resp.status_code == 401
    body = resp.json()
    assert body["status_code"] == 401
    assert isinstance(body["detail"], str)
    assert isinstance(body["code"], str)


@pytest.mark.parametrize(
    ("exc_factory", "status"),
    [
        (lambda: __import__("geometrikks.domain.exceptions", fromlist=["x"]).DomainNotFoundError("gone"), 404),
        (lambda: __import__("geometrikks.domain.exceptions", fromlist=["x"]).DomainConflictError("pinned"), 409),
    ],
)
def test_domain_lookup_errors_render_native_envelope(exc_factory, status):
    from litestar.testing import RequestFactory

    from geometrikks.server.exceptions import EXCEPTION_HANDLERS

    exc = exc_factory()
    handler = EXCEPTION_HANDLERS[type(exc)]
    response = handler(RequestFactory().get("/api/v1/x"), exc)
    assert response.status_code == status
    assert response.content == {"status_code": status, "detail": exc.detail, "code": exc.code}


@pytest.mark.parametrize(
    ("exception_type", "expected_code"),
    [
        ("InvalidApiKeyError", "api_key_invalid"),
        ("ExpiredApiKeyError", "api_key_expired"),
        ("ReadOnlyApiKeyError", "api_key_read_only"),
        ("SessionRequiredError", "session_required"),
        ("ApiKeysUnavailableError", "api_keys_unavailable"),
    ],
)
async def test_specific_codes_preserve_headers_and_extra(exception_type, expected_code):
    from litestar import Litestar, get
    from geometrikks.server import exceptions

    @get("/api/v1/error")
    async def fail() -> None:
        raise getattr(exceptions, exception_type)(
            detail="unchanged", headers={"Retry-After": "60"}, extra=[{"key": "field"}],
        )

    async with AsyncTestClient(app=Litestar([fail], exception_handlers=exceptions.EXCEPTION_HANDLERS)) as client:
        response = await client.get("/api/v1/error")
    assert response.headers["Retry-After"] == "60"
    assert response.json() == {
        "status_code": response.status_code, "detail": "unchanged",
        "code": expected_code, "extra": [{"key": "field"}],
    }


async def test_internal_http_errors_do_not_expose_the_detail():
    from litestar import Litestar, get
    from litestar.exceptions import InternalServerException
    from geometrikks.server.exceptions import EXCEPTION_HANDLERS

    @get("/api/v1/error")
    async def fail() -> None:
        raise InternalServerException(detail="private information")

    async with AsyncTestClient(app=Litestar([fail], exception_handlers=EXCEPTION_HANDLERS)) as client:
        response = await client.get("/api/v1/error")
    assert response.json() == {"status_code": 500, "detail": "Internal Server Error", "code": "internal_error"}


def test_domain_error_can_supply_a_specific_code():
    from litestar.testing import RequestFactory
    from geometrikks.domain.exceptions import DomainValidationError
    from geometrikks.server.exceptions import handle_domain_validation_error

    response = handle_domain_validation_error(
        RequestFactory().get("/api/v1/x"), DomainValidationError("Invalid bounds", code="invalid_range"),
    )
    assert response.content["code"] == "invalid_range"


async def test_non_api_http_errors_keep_the_framework_envelope():
    from litestar import Litestar, get
    from litestar.exceptions import PermissionDeniedException
    from geometrikks.server.exceptions import EXCEPTION_HANDLERS

    @get("/outside")
    async def fail() -> None:
        raise PermissionDeniedException(detail="denied", headers={"X-Reason": "example"})

    async with AsyncTestClient(app=Litestar([fail], exception_handlers=EXCEPTION_HANDLERS)) as client:
        response = await client.get("/outside")
    assert response.json() == {"status_code": 403, "detail": "denied"}
    assert response.headers["X-Reason"] == "example"


def test_debug_http_errors_keep_the_debug_response():
    from litestar import Litestar
    from litestar.exceptions import InternalServerException
    from litestar.testing import RequestFactory
    from geometrikks.server.exceptions import handle_http_exception

    app = Litestar(debug=True)
    response = handle_http_exception(
        RequestFactory(app=app).get("/api/v1/error"), InternalServerException(detail="debug detail"),
    )
    assert response.status_code == 500
    assert response.media_type != "application/json"
