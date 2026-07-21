"""Endpoint tests for login/logout/me and the auth middleware boundary."""
from __future__ import annotations

from typing import Any

import pytest
from litestar import Litestar, get
from litestar.testing import TestClient

from geometrikks.config.settings import Settings
from geometrikks.api.v1.auth_controller import AuthController
from geometrikks.api.v1.live_controller import live_feed
from geometrikks.server.auth import build_auth_state, create_session_auth

from tests.test_live_ws import FakeIngestion


@get("/api/v1/protected")
async def protected() -> dict[str, Any]:
    return {"ok": True}


@get("/health")
async def fake_health() -> dict[str, Any]:
    return {"status": "healthy"}


def make_app(**settings_kwargs) -> Litestar:
    settings = Settings(admin_user="admin", admin_password="bestpasswordintheworldnojoke", **settings_kwargs)
    session_auth = create_session_auth(settings)
    app = Litestar(
        route_handlers=[AuthController, protected, fake_health, live_feed],
        on_app_init=[session_auth.on_app_init],
    )
    app.state.auth_state = build_auth_state(settings)
    # A working ingestion service so the authenticated branch streams rather
    # than taking the 1013-close (no-service) path.
    app.state.ingestion_service = FakeIngestion()
    return app


def test_protected_route_401_without_session():
    with TestClient(app=make_app()) as client:
        assert client.get("/api/v1/protected").status_code == 401


def test_excluded_paths_do_not_require_auth():
    with TestClient(app=make_app()) as client:
        assert client.get("/health").status_code == 200


def test_login_wrong_password_is_401():
    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "wrong"},
        )
        assert res.status_code == 401


def test_login_logout_flow():
    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert res.status_code == 200
        assert res.json() == {"username": "admin"}

        # Session cookie now grants access
        assert client.get("/api/v1/protected").status_code == 200
        me = client.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json() == {"username": "admin"}

        assert client.post("/api/v1/auth/logout").status_code == 204
        assert client.get("/api/v1/protected").status_code == 401


def test_ws_live_rejected_without_session():
    from litestar.exceptions import WebSocketDisconnect

    with TestClient(app=make_app()) as client:
        # The middleware's NotAuthorizedException closes the handshake
        # (4000 + 401 = 4401), surfaced by the test client as a disconnect.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/live") as ws:
                ws.receive_json(timeout=2)


def test_ws_live_streams_after_login():
    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert res.status_code == 200
        # Same client -> the session cookie persists onto the WS handshake.
        ingestion = client.app.state.ingestion_service
        with client.websocket_connect("/ws/live") as ws:
            ingestion.queue.put_nowait(_ws_record())
            frame = ws.receive_json(timeout=5)
        assert frame["type"] == "batch"
        assert [e["type"] for e in frame["events"]] == ["geo_event", "access_log"]


def _ws_record():
    from tests.test_live_ws import make_record

    return make_record()


def test_create_app_requires_password_when_auth_enabled(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "false")
    # Empty string (falsy) rather than delenv: real env vars beat .env, so this
    # holds even when a local .env sets APP_ADMIN_PASSWORD for dev.
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "")
    from geometrikks.server.core import create_app
    with pytest.raises(RuntimeError, match="APP_ADMIN_PASSWORD"):
        create_app()


def test_create_app_auth_disabled_builds_without_password(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    monkeypatch.delenv("APP_ADMIN_PASSWORD", raising=False)
    from geometrikks.server.core import create_app
    app = create_app()
    assert app.state.auth_state is None


AUTH_ROUTE_PATHS = {"/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/me"}


def test_auth_routes_not_registered_when_auth_disabled(monkeypatch):
    # Without SessionAuth there is no auth_state / request.user, so the
    # handlers must not be reachable at all (404 instead of a 500).
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    monkeypatch.delenv("APP_ADMIN_PASSWORD", raising=False)
    from geometrikks.server.core import create_app
    app = create_app()
    paths = {route.path for route in app.routes}
    assert not (AUTH_ROUTE_PATHS & paths)


def test_auth_routes_registered_when_auth_enabled(monkeypatch):
    monkeypatch.setenv("APP_AUTH_DISABLED", "false")
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "bestpasswordintheworldnojoke")
    from geometrikks.server.core import create_app
    app = create_app()
    paths = {route.path for route in app.routes}
    assert AUTH_ROUTE_PATHS <= paths


def test_session_cookie_secure_flag_follows_setting():
    with TestClient(app=make_app(session_secure=True)) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert res.status_code == 200
        assert "secure" in res.headers["set-cookie"].lower()

    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert "secure" not in res.headers["set-cookie"].lower()
