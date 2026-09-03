"""The settings endpoint must expose an explicit whitelist — never credentials."""
from __future__ import annotations

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.domain.system.controllers.settings import read_settings
from geometrikks.services.geoip.home import HomeLocation
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency


def make_app() -> Litestar:
    app = Litestar(
        route_handlers=[create_api_v1_router([read_settings])],
        dependencies=ambient_settings_dependency(),
    )
    app.state.map_home_location = HomeLocation(40.7128, -74.006, "external_ip")
    return app


def test_settings_moved_under_api_v1():
    with TestClient(app=make_app()) as client:
        assert client.get("/settings").status_code == 404
        assert client.get("/api/v1/settings").status_code == 200


def test_settings_response_is_whitelisted():
    with TestClient(app=make_app()) as client:
        body = client.get("/api/v1/settings").json()

    # Whitelisted keys present
    assert body["name"]
    assert body["version"]
    assert body["environment"]
    assert body["runtime"] == {"container": False, "imageTag": None}
    assert "logPaths" in body["logparser"]
    assert "rawRetentionDays" in body["analytics"]
    assert body["map"] == {
        "homeLatitude": 40.7128,
        "homeLongitude": -74.006,
        "homeSource": "external_ip",
        "cartoApiKey": None,
    }

    # Credential material absent anywhere in the payload
    flat = str(body).lower()
    for forbidden in ("password", "geopass", "database", "db_", "admin"):
        assert forbidden not in flat, f"leaked: {forbidden}"


def test_settings_reports_container_build_metadata(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME", "container")
    monkeypatch.setenv("APP_IMAGE_TAG", "v0.2.2-dev.4")

    with TestClient(app=make_app()) as client:
        body = client.get("/api/v1/settings").json()

    assert body["runtime"] == {
        "container": True,
        "imageTag": "v0.2.2-dev.4",
    }


def test_settings_exposes_carto_api_key(monkeypatch):
    """The basemap key is sent to the browser on purpose: MapLibre needs it on tile URLs."""
    monkeypatch.setenv("MAP_CARTO_API_KEY", "carto-public-key")

    with TestClient(app=make_app()) as client:
        body = client.get("/api/v1/settings").json()

    assert body["map"]["cartoApiKey"] == "carto-public-key"
