"""create_app() composition: explicit settings and dependency overrides."""
from __future__ import annotations

import pytest
import structlog
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import DatabaseSettings, Settings
from geometrikks.server.core import create_app

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _reset_structlog_config():
    """Undo the StructlogPlugin's global configuration after each test.

    The plugin enables cache_logger_on_first_use; leaving that active would
    let later-bound loggers bypass structlog.testing.capture_logs() in other
    test modules.
    """
    yield
    structlog.reset_defaults()


def _hermetic_settings(**overrides) -> Settings:
    return Settings(
        auth_disabled=True,
        # Unroutable database -> startup takes the degraded path immediately,
        # so these tests never touch a real developer database.
        database=DatabaseSettings(host="127.0.0.1", port=59999),
        **overrides,
    )


def test_create_app_prefers_explicit_settings_over_env(monkeypatch):
    monkeypatch.setenv("APP_NAME", "Ambient Name")
    settings = _hermetic_settings(name="Explicit Name")
    app = create_app(settings=settings)
    assert app.state.settings is settings
    assert app.openapi_config is not None
    assert app.openapi_config.title == "Explicit Name"


async def test_request_handlers_receive_explicit_settings(monkeypatch):
    monkeypatch.setenv("APP_NAME", "Ambient Name")
    app = create_app(settings=_hermetic_settings(name="Explicit Name"))
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/settings")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Explicit Name"


async def test_dependency_overrides_replace_defaults():
    replaced = _hermetic_settings(name="Overridden")

    def provide_replaced() -> Settings:
        return replaced

    app = create_app(
        settings=_hermetic_settings(name="Composed"),
        dependencies={"settings": Provide(provide_replaced, sync_to_thread=False)},
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/settings")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Overridden"
