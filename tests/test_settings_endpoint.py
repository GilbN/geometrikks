"""The settings endpoint must expose an explicit whitelist — never credentials."""
from __future__ import annotations

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.api.v1.settings import read_settings


def make_app() -> Litestar:
    return Litestar(route_handlers=[read_settings])


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
    assert "log_paths" in body["logparser"]
    assert "raw_retention_days" in body["analytics"]

    # Credential material absent anywhere in the payload
    flat = str(body).lower()
    for forbidden in ("password", "geopass", "database", "db_", "admin"):
        assert forbidden not in flat, f"leaked: {forbidden}"
