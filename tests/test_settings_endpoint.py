"""The settings endpoint must expose an explicit whitelist — never credentials."""
from __future__ import annotations

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.api.v1.settings import read_settings
from geometrikks.services.geoip.home import HomeLocation


def make_app() -> Litestar:
    app = Litestar(route_handlers=[read_settings])
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
    assert body["runtime"] == {"container": False, "image_tag": None}
    assert "log_paths" in body["logparser"]
    assert "raw_retention_days" in body["analytics"]
    assert body["map"] == {
        "home_latitude": 40.7128,
        "home_longitude": -74.006,
        "home_source": "external_ip",
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
        "image_tag": "v0.2.2-dev.4",
    }
