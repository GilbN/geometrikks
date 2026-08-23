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


def test_site_homes_route_present_in_full_mode(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/site-homes" in paths


def test_site_homes_route_absent_in_agent_mode(monkeypatch):
    monkeypatch.setenv("APP_MODE", "agent")
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/site-homes" not in paths
    assert paths == {"/health", "/health/ready"}


def test_site_home_delete_route_present_in_full_mode(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/site-homes/{hostname:str}" in paths
