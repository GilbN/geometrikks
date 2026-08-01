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
    test modules. Re-running ensure_default_configuration() restores the
    import-time SuccessBoundLogger defaults that logger.success() callers
    rely on.
    """
    from geometrikks.server.logging import ensure_default_configuration

    yield
    structlog.reset_defaults()
    ensure_default_configuration()


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


def test_settings_dependency_is_reserved():
    """A request-level settings override would diverge from the settings the
    plugins, auth, and lifecycle were composed with; settings= is the one way
    in."""
    def provide_other() -> Settings:
        return _hermetic_settings()

    with pytest.raises(ValueError, match="settings"):
        create_app(
            settings=_hermetic_settings(),
            dependencies={"settings": Provide(provide_other, sync_to_thread=False)},
        )


def test_extra_dependencies_are_registered():
    def provide_marker() -> str:
        return "marker"

    app = create_app(
        settings=_hermetic_settings(),
        dependencies={"marker_service": Provide(provide_marker, sync_to_thread=False)},
    )
    assert "marker_service" in app.dependencies


def test_database_stack_binds_to_explicit_settings(monkeypatch):
    """The SQLAlchemy engine must come from the explicit settings object,
    never from ambient environment configuration."""
    monkeypatch.setenv("DB_HOST", "ambient.invalid")
    app = create_app(settings=_hermetic_settings())
    url = str(app.state.db_config.get_engine().url)
    assert "127.0.0.1" in url
    assert "ambient.invalid" not in url


async def test_domain_validation_error_translates_to_400():
    """Central handler: DomainValidationError raised inside a dependency
    provider (IP filter validation) must surface as a 400, not a 500."""
    app = create_app(settings=_hermetic_settings())
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/geo-events/", params={"ipAddressIn": "not-an-ip"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["status_code"] == 400
    assert "Invalid IP address" in body["detail"]


def test_create_plugins_derives_db_config_from_explicit_settings(monkeypatch):
    """create_plugins(settings=...) without a db_config must not fall back to
    the ambient process-cached engine (split-brain configuration)."""
    from advanced_alchemy.extensions.litestar import SQLAlchemyInitPlugin

    from geometrikks.server import plugins as plugins_mod

    monkeypatch.setenv("DB_HOST", "ambient.invalid")
    plugin_list = plugins_mod.create_plugins(settings=_hermetic_settings())
    init_plugin = next(p for p in plugin_list if isinstance(p, SQLAlchemyInitPlugin))
    url = str(init_plugin.config[0].get_engine().url)
    assert "127.0.0.1" in url
    assert "ambient.invalid" not in url
