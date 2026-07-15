"""Debug endpoints are always available; OpenAPI metadata is presentable."""
from __future__ import annotations


def _route_paths(app) -> set[str]:
    return {route.path for route in app.routes}


def test_debug_routes_present_in_production(monkeypatch):
    monkeypatch.setenv("APP_DEBUG", "false")
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert any("access-log-debug" in p for p in paths), paths


def test_debug_routes_present_in_debug(monkeypatch):
    monkeypatch.setenv("APP_DEBUG", "true")
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert any("access-log-debug" in p for p in paths), paths
