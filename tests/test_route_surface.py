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


def _query_params_by_operation(app) -> dict[str, set[str]]:
    schema = app.openapi_schema.to_schema()
    params: dict[str, set[str]] = {}
    for path, path_item in schema["paths"].items():
        for method, operation in path_item.items():
            if not isinstance(operation, dict) or "parameters" not in operation:
                continue
            params[f"{method.upper()} {path}"] = {
                parameter["name"] for parameter in operation["parameters"] if parameter["in"] == "query"
            }
    return params


def test_server_locations_route_present_in_full_mode(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/server-locations" in paths


def test_server_locations_route_absent_in_agent_mode(monkeypatch):
    monkeypatch.setenv("APP_MODE", "agent")
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/server-locations" not in paths
    assert paths == {"/health", "/health/ready"}


def test_server_location_delete_route_present_in_full_mode(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/geo-locations/server-locations/{server:str}" in paths


def test_site_homes_routes_are_gone(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert not [path for path in paths if "site-homes" in path]


def test_server_handler_names(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    from litestar.routes import HTTPRoute

    handler_names = {
        route_handler.handler_name
        for route in create_app().routes
        if isinstance(route, HTTPRoute) and "server-locations" in route.path
        for route_handler in route.route_handlers
    }
    assert handler_names - {"options_handler"} == {"server_locations", "delete_server_location"}


def test_server_filter_params_replace_hostname_params(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    params_by_operation = _query_params_by_operation(create_app())
    declared = set().union(*params_by_operation.values())
    assert "hostnameIn" not in declared
    assert "hostnameNotIn" not in declared
    assert {"serverIn", "serverNotIn"} <= params_by_operation["GET /api/v1/access-logs"]
    assert "serverIn" in params_by_operation["GET /api/v1/geo-events"]
    operations_with_server_in = [
        operation for operation, names in params_by_operation.items() if "serverIn" in names
    ]
    assert len(operations_with_server_in) == 11, operations_with_server_in


def test_instances_routes_present_in_full_mode(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert "/api/v1/instances" in paths
    assert "/api/v1/instances/{instance_name:str}" in paths


def test_instances_routes_absent_in_agent_mode(monkeypatch):
    monkeypatch.setenv("APP_MODE", "agent")
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    from geometrikks.server.core import create_app
    paths = _route_paths(create_app())
    assert not any("/instances" in path for path in paths)
