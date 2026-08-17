"""Endpoint tests for login/logout/me and the auth middleware boundary."""
from __future__ import annotations

from typing import Any

import pytest
from litestar import Litestar, get
from litestar.channels import ChannelsPlugin
from litestar.channels.backends.memory import MemoryChannelsBackend
from litestar.testing import TestClient

from geometrikks.config.settings import Settings
from geometrikks.domain.auth.controllers import AuthController
from geometrikks.domain.realtime.controllers import crowdsec_feed, live_feed, logs_feed
from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL
from geometrikks.server.auth import build_auth_state, create_session_auth
from geometrikks.server.dependencies import create_settings_provider
from geometrikks.server.routes import create_api_v1_router


@get("/api/v1/protected")
async def protected() -> dict[str, Any]:
    return {"ok": True}


@get("/health")
async def fake_health() -> dict[str, Any]:
    return {"status": "healthy"}


def make_app(**settings_kwargs) -> Litestar:
    settings = Settings(
        admin_user="admin",
        admin_password="bestpasswordintheworldnojoke",
        _env_file=None,
        **settings_kwargs,
    )
    session_auth = create_session_auth(settings)
    channels = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=[LIVE_EVENTS_CHANNEL])
    app = Litestar(
        route_handlers=[
            create_api_v1_router([AuthController]),
            protected, fake_health, live_feed, crowdsec_feed, logs_feed,
        ],
        dependencies={"settings": create_settings_provider(settings)},
        on_app_init=[session_auth.on_app_init],
        plugins=[channels],
        logging_config=None,
    )
    app.state.auth_state = build_auth_state(settings)
    # DB "available" so the authenticated branch streams rather than taking
    # the 1013-close (degraded) path.
    app.state.db_available = True
    return app


def make_disabled_app() -> Litestar:
    """APP_AUTH_DISABLED=true: no session middleware, no auth_state.

    Mirrors what create_app() composes in that mode, without the lifespan
    (and therefore without needing a database).
    """
    settings = Settings(admin_user="admin", auth_disabled=True, _env_file=None)
    app = Litestar(
        route_handlers=[create_api_v1_router([AuthController]), protected, fake_health],
        dependencies={"settings": create_settings_provider(settings)},
        logging_config=None,
    )
    app.state.auth_state = None
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
        assert res.json() == {"mode": "session", "username": "admin"}

        # Session cookie now grants access
        assert client.get("/api/v1/protected").status_code == 200
        me = client.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json() == {"mode": "session", "username": "admin"}

        assert client.post("/api/v1/auth/logout").status_code == 204
        assert client.get("/api/v1/protected").status_code == 401


@pytest.mark.parametrize("path", ["/ws/live", "/ws/crowdsec", "/ws/logs"])
def test_ws_feeds_rejected_without_session(path):
    from litestar.exceptions import WebSocketDisconnect

    with TestClient(app=make_app()) as client:
        # The middleware's NotAuthorizedException closes the handshake
        # (4000 + 401 = 4401), surfaced by the test client as a disconnect.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path) as ws:
                ws.receive_json(timeout=2)


def test_ws_live_streams_after_login():
    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert res.status_code == 200
        # Same client -> the session cookie persists onto the WS handshake.
        channels = client.app.plugins.get(ChannelsPlugin)
        with client.websocket_connect("/ws/live") as ws:
            channels.publish(_ws_event(), LIVE_EVENTS_CHANNEL)
            frame = ws.receive_json(timeout=5)
        assert frame["type"] == "batch"
        assert [e["type"] for e in frame["events"]] == ["request"]


def _ws_event():
    from tests.test_live_ws import make_record
    from geometrikks.domain.realtime.events import record_to_event

    return record_to_event(make_record())


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


def test_auth_routes_registered_when_auth_disabled(monkeypatch):
    # The SPA calls /auth/me on every load. Leaving the routes unregistered
    # made every load raise NotFoundException and log an error-level
    # traceback, which is the whole point of this change.
    monkeypatch.setenv("APP_AUTH_DISABLED", "true")
    monkeypatch.delenv("APP_ADMIN_PASSWORD", raising=False)
    from geometrikks.server.core import create_app
    app = create_app()
    paths = {route.path for route in app.routes}
    assert AUTH_ROUTE_PATHS <= paths


def test_me_reports_disabled_mode():
    with TestClient(app=make_disabled_app()) as client:
        res = client.get("/api/v1/auth/me")
        assert res.status_code == 200
        assert res.json() == {"mode": "disabled"}


def test_login_is_a_no_op_when_auth_disabled():
    with TestClient(app=make_disabled_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "does-not-matter"},
        )
        assert res.status_code == 200
        assert res.json() == {"mode": "disabled"}
        # No session was established, so nothing to set.
        assert "set-cookie" not in res.headers


def test_login_still_validates_its_body_when_auth_disabled():
    # Litestar validates `data: LoginPayload` before the handler runs. The
    # mode changes what valid credentials do, not whether the request shape
    # is checked, and a 400 stays loud in the log.
    with TestClient(app=make_disabled_app()) as client:
        assert client.post("/api/v1/auth/login", json={"username": "admin"}).status_code == 400


def test_logout_is_a_no_op_when_auth_disabled():
    with TestClient(app=make_disabled_app()) as client:
        assert client.post("/api/v1/auth/logout").status_code == 204


def test_disabled_login_writes_no_audit_event():
    # Nobody logged in, so the login.log contract must stay silent. A
    # login_success here would be a false audit record.
    import structlog

    with structlog.testing.capture_logs() as captured:
        with TestClient(app=make_disabled_app()) as client:
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "does-not-matter"},
            )
            client.post("/api/v1/auth/logout")
    events = {e["event"] for e in captured}
    assert not events & {"login_success", "login_failed", "logout"}


def test_me_is_401_for_an_anonymous_caller_when_auth_enabled():
    # The frontend depends on this: the axios interceptor turns the 401 into
    # a redirect to /login. Adding the disabled-mode branch must not have
    # made /auth/me publicly readable.
    with TestClient(app=make_app()) as client:
        assert client.get("/api/v1/auth/me").status_code == 401


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


def test_non_api_responses_never_touch_the_session():
    """The session middleware must not run outside /api and /ws.

    When it runs on the SPA shell and static assets, every such response
    writes the session it loaded at request start back to the store. A slow
    asset response that started before login then overwrites the fresh
    authenticated session with stale pre-login data, and the next API call
    401s: login bounces straight back to the login page.
    """
    with TestClient(app=make_app()) as client:
        res = client.get("/health")
        assert res.status_code == 200
        assert "set-cookie" not in res.headers


def test_session_survives_non_api_requests_after_login():
    with TestClient(app=make_app()) as client:
        res = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
        )
        assert res.status_code == 200
        client.get("/health")
        assert client.get("/api/v1/auth/me").status_code == 200


def test_login_attempts_are_logged_with_client_ip():
    import structlog

    app = make_app()
    with structlog.testing.capture_logs() as captured:
        with TestClient(app=app) as client:
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "wrong"},
            )
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
            )
    failed = [e for e in captured if e["event"] == "login_failed"]
    succeeded = [e for e in captured if e["event"] == "login_success"]
    assert len(failed) == 1 and failed[0]["log_level"] == "warning"
    assert len(succeeded) == 1 and succeeded[0]["log_level"] == "info"
    # Both carry the username and the client IP (TestClient peer).
    assert failed[0]["user"] == "admin" and failed[0]["ip"]
    assert succeeded[0]["user"] == "admin" and succeeded[0]["ip"]


class TestLoginLogFile:
    def test_login_events_written_in_contract_format(self, tmp_path, monkeypatch):
        from tests.test_logging_pipeline import LOGIN_LINE_RE, _wait_for

        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        assert config.standard_lib_logging_config is not None
        config.standard_lib_logging_config.configure()

        with TestClient(app=make_app()) as client:
            client.post("/api/v1/auth/login", json={"username": "admin", "password": "wrong"})
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "bestpasswordintheworldnojoke"},
            )
            client.post("/api/v1/auth/logout")

        login_file = tmp_path / "logs" / "login.log"
        assert _wait_for(lambda: login_file.exists() and "logout" in login_file.read_text(encoding="utf-8"))
        lines = login_file.read_text(encoding="utf-8").splitlines()
        assert [l.split(" ")[1] for l in lines] == ["login_failed", "login_success", "logout"]
        for line in lines:
            assert LOGIN_LINE_RE.match(line), line
