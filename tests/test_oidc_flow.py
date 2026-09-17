"""OIDC through the auth endpoints, against the in-process fake provider."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
import structlog
from litestar import Litestar
from litestar.channels import ChannelsPlugin
from litestar.channels.backends.memory import MemoryChannelsBackend
from litestar.testing import TestClient

from geometrikks.config.settings import OidcSettings, Settings
from geometrikks.domain.auth.controllers import AuthController
from geometrikks.domain.realtime.controllers import live_feed
from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL
from geometrikks.server.auth import build_auth_state, create_session_auth
from geometrikks.server.dependencies import create_settings_provider
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.oidc import OidcClient
from geometrikks.services.oidc import client as client_module
from tests.oidc_fake import CLIENT_ID, CLIENT_SECRET, ISSUER, REDIRECT_URI, FakeIdp, make_fake_idp
from tests.test_auth_endpoints import _ws_event, make_app, make_disabled_app, protected

PASSWORD = "bestpasswordintheworldnojoke"
CREDS = {"username": "admin", "password": PASSWORD}
OIDC_DEFAULTS: dict[str, Any] = dict(
    issuer=ISSUER,
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET,
    redirect_uri=REDIRECT_URI,
    allowed_groups=["admins"],
)


def make_oidc_app(
    fake: FakeIdp,
    *,
    password: bool = True,
    session_max_age: int | None = None,
    extra_handlers: Sequence[Any] = (),
    **oidc_overrides: Any,
) -> Litestar:
    """The same composition create_app() builds, minus the lifespan."""
    oidc = OidcSettings(_env_file=None, **{**OIDC_DEFAULTS, **oidc_overrides})
    settings = Settings(
        admin_user="admin",
        admin_password=PASSWORD if password else None,
        oidc=oidc,
        _env_file=None,
    )
    session_auth = create_session_auth(settings)
    if session_max_age is not None:
        session_auth.session_backend_config.max_age = session_max_age
    channels = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=[LIVE_EVENTS_CHANNEL])
    app = Litestar(
        route_handlers=[create_api_v1_router([AuthController]), protected, live_feed, *extra_handlers],
        dependencies={"settings": create_settings_provider(settings)},
        on_app_init=[session_auth.on_app_init],
        plugins=[channels],
        logging_config=None,
    )
    app.state.auth_state = build_auth_state(settings)
    app.state.db_available = True
    app.state.oidc_client = OidcClient(settings.oidc, fake.http_client())
    return app


def oidc_login(client: TestClient, fake: FakeIdp):
    """Start, play the IdP, hit the callback; return the callback response."""
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    assert start.status_code == 302, start.text
    return client.get(fake.issue_code(start.headers["location"]), follow_redirects=False)


@pytest.fixture
def fake() -> FakeIdp:
    return make_fake_idp()


# Options: what the login page may show, readable before anyone is logged in.


def test_options_password_only():
    with TestClient(app=make_app()) as client:
        res = client.get("/api/v1/auth/options")
        assert res.status_code == 200
        assert res.json() == {"password": True, "oidc": None}


def test_options_oidc_only(fake):
    with TestClient(app=make_oidc_app(fake, password=False)) as client:
        assert client.get("/api/v1/auth/options").json() == {
            "password": False,
            "oidc": {"providerName": "SSO"},
        }


def test_options_both_with_a_custom_provider_name(fake):
    with TestClient(app=make_oidc_app(fake, provider_name="Authelia")) as client:
        assert client.get("/api/v1/auth/options").json() == {
            "password": True,
            "oidc": {"providerName": "Authelia"},
        }


def test_options_when_auth_is_disabled():
    with TestClient(app=make_disabled_app()) as client:
        assert client.get("/api/v1/auth/options").json() == {"password": False, "oidc": None}


# Status: discovery outcome for Settings > Status. Authenticated.


def test_status_requires_a_session(fake):
    with TestClient(app=make_oidc_app(fake)) as client:
        assert client.get("/api/v1/auth/oidc/status").status_code == 401


def test_status_reports_pending_then_ok(fake):
    with TestClient(app=make_oidc_app(fake, logout_idp=True)) as client:
        assert client.post("/api/v1/auth/login", json=CREDS).status_code == 200
        before = client.get("/api/v1/auth/oidc/status").json()
        assert before == {
            "configured": True,
            "providerName": "SSO",
            "issuer": ISSUER,
            "discovery": "pending",
            "detail": None,
            "passwordLogin": True,
            "idpLogout": True,
        }
        client.get("/api/v1/auth/oidc/start", follow_redirects=False)
        after = client.get("/api/v1/auth/oidc/status").json()
        assert after["discovery"] == "ok"


def test_status_reports_a_failed_discovery(fake):
    fake.config.fail["discovery"] = 500
    with TestClient(app=make_oidc_app(fake)) as client:
        client.post("/api/v1/auth/login", json=CREDS)
        client.get("/api/v1/auth/oidc/start", follow_redirects=False)
        status = client.get("/api/v1/auth/oidc/status").json()
        assert status["discovery"] == "failed"
        assert "HTTP 500" in status["detail"]


def test_status_when_oidc_is_not_configured():
    with TestClient(app=make_app()) as client:
        client.post("/api/v1/auth/login", json=CREDS)
        status = client.get("/api/v1/auth/oidc/status").json()
        assert status["configured"] is False
        assert status["passwordLogin"] is True
        assert status["issuer"] is None


def _login_failed_reasons(captured) -> list[str]:
    return [e["reason"] for e in captured if e["event"] == "login_failed"]


def test_start_redirects_to_the_provider_with_pkce(fake):
    with TestClient(app=make_oidc_app(fake)) as client:
        res = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
        assert res.status_code == 302
        assert res.headers["cache-control"] == "no-store"
        assert res.cookies.get("session")
        location = urlsplit(res.headers["location"])
        assert f"{location.scheme}://{location.netloc}{location.path}" == fake.config.url("/authorize")
        query = parse_qs(location.query)
        assert query["client_id"] == [CLIENT_ID]
        assert query["redirect_uri"] == [REDIRECT_URI]
        assert query["scope"] == ["openid profile email groups"]
        assert query["code_challenge_method"] == ["S256"]
        assert all(len(query[k][0]) == 43 for k in ("state", "nonce", "code_challenge"))
        assert "code_verifier" not in location.query


def test_start_is_404_without_oidc():
    with TestClient(app=make_app()) as client:
        assert client.get("/api/v1/auth/oidc/start", follow_redirects=False).status_code == 404


def test_start_sends_the_browser_back_when_discovery_fails(fake):
    fake.config.fail["discovery"] = 500
    with structlog.testing.capture_logs() as captured:
        with TestClient(app=make_oidc_app(fake)) as client:
            res = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["location"] == "/login?error=oidc_unavailable"
    assert _login_failed_reasons(captured) == ["discovery"]


def test_callback_happy_path(fake):
    with structlog.testing.capture_logs() as captured:
        with TestClient(app=make_oidc_app(fake)) as client:
            start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
            pre_login = start.cookies["session"]
            res = client.get(fake.issue_code(start.headers["location"]), follow_redirects=False)
            assert res.status_code == 302
            assert res.headers["location"] == "/"
            assert res.cookies["session"] != pre_login
            assert client.get("/api/v1/auth/me").json() == {
                "mode": "session",
                "username": "gil",
                "provider": "oidc",
            }
            assert client.get("/api/v1/protected").status_code == 200
            channels = client.app.plugins.get(ChannelsPlugin)
            with client.websocket_connect("/ws/live") as ws:
                channels.publish(_ws_event(), LIVE_EVENTS_CHANNEL)
                assert ws.receive_json(timeout=5)["type"] == "batch"
    success = [e for e in captured if e["event"] == "login_success"]
    assert len(success) == 1
    assert success[0]["provider"] == "oidc"
    assert success[0]["user"] == "gil"
    assert success[0]["subject"] == "user-1"


def _stored_session(client: TestClient) -> bytes:
    store = client.app.stores.get("sessions")
    with client.portal() as portal:
        raw = portal.call(store.get, client.cookies["session"])
    assert raw is not None
    return raw


def test_callback_keeps_the_id_token_only_for_idp_logout(fake):
    with TestClient(app=make_oidc_app(fake)) as client:
        oidc_login(client, fake)
        assert b"id_token" not in _stored_session(client)
    with TestClient(app=make_oidc_app(fake, logout_idp=True)) as client:
        oidc_login(client, fake)
        assert b"id_token" in _stored_session(client)


@pytest.mark.parametrize(
    ("setup", "code", "reason"),
    [
        ("no_pending", "oidc_failed", "state_mismatch"),
        ("wrong_state", "oidc_failed", "state_mismatch"),
        ("idp_error", "oidc_denied", "idp_error"),
        ("no_code", "oidc_failed", "missing_code"),
        ("token_500", "oidc_failed", "token_exchange"),
        ("bad_audience", "oidc_failed", "id_token_invalid"),
        ("not_allowed", "oidc_forbidden", "not_allowed"),
        ("expired", "oidc_failed", "pending_expired"),
    ],
)
def test_callback_failures(fake, monkeypatch, setup, code, reason):
    if setup == "token_500":
        fake.config.fail["token"] = 500
    if setup == "bad_audience":
        fake.config.claims = {"aud": "someone-else"}
    if setup == "not_allowed":
        fake.config.userinfo["groups"] = ["guests"]
    with structlog.testing.capture_logs() as captured:
        with TestClient(app=make_oidc_app(fake)) as client:
            if setup == "no_pending":
                res = client.get("/api/v1/auth/oidc/callback?code=x&state=y", follow_redirects=False)
            else:
                start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
                callback = fake.issue_code(start.headers["location"])
                path, _, query = callback.partition("?")
                params = parse_qs(query)
                if setup == "wrong_state":
                    callback = f"{path}?code={params['code'][0]}&state=not-it"
                elif setup == "idp_error":
                    callback = f"{path}?error=access_denied&state={params['state'][0]}"
                elif setup == "no_code":
                    callback = f"{path}?state={params['state'][0]}"
                elif setup == "expired":
                    monkeypatch.setattr(client_module, "_now", lambda: client_module.time.time() + 601)
                res = client.get(callback, follow_redirects=False)
            assert res.status_code == 302
            assert res.headers["location"] == f"/login?error={code}"
            assert client.get("/api/v1/auth/me").status_code == 401
    assert _login_failed_reasons(captured) == [reason]
    if setup == "not_allowed":
        denied = next(e for e in captured if e["event"] == "login_failed")
        assert denied["groups"] == ["guests"]
        assert denied["subject"] == "user-1"
    if setup == "idp_error":
        denied = next(e for e in captured if e["event"] == "login_failed")
        assert denied["error"] == "access_denied"


def test_callback_consumes_the_pending_login_on_failure(fake):
    fake.config.fail["token"] = 500
    with TestClient(app=make_oidc_app(fake)) as client:
        start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
        callback = fake.issue_code(start.headers["location"])
        assert client.get(callback, follow_redirects=False).headers["location"] == "/login?error=oidc_failed"
        del fake.config.fail["token"]
        # Replaying the same callback finds no pending login.
        assert client.get(callback, follow_redirects=False).headers["location"] == "/login?error=oidc_failed"


def test_password_login_still_works_beside_oidc(fake):
    with TestClient(app=make_oidc_app(fake)) as client:
        res = client.post("/api/v1/auth/login", json=CREDS)
        assert res.status_code == 200
        assert res.json()["provider"] == "password"


def test_logout_is_local_by_default(fake):
    with structlog.testing.capture_logs() as captured:
        with TestClient(app=make_oidc_app(fake)) as client:
            oidc_login(client, fake)
            res = client.post("/api/v1/auth/logout")
            assert res.status_code == 200
            assert res.json() == {"redirectTo": None}
            assert client.get("/api/v1/auth/me").status_code == 401
    logout = next(e for e in captured if e["event"] == "logout")
    assert logout["provider"] == "oidc"
    assert logout["idp_logout"] is False
    assert logout["user"] == "gil"
    assert logout["ip"] == "testclient"


def test_logout_redirects_to_the_provider_when_enabled(fake):
    with TestClient(app=make_oidc_app(fake, logout_idp=True)) as client:
        oidc_login(client, fake)
        res = client.post("/api/v1/auth/logout")
        redirect_to = res.json()["redirectTo"]
        assert redirect_to is not None
        parts = urlsplit(redirect_to)
        assert f"{parts.scheme}://{parts.netloc}{parts.path}" == fake.config.url("/end-session")
        query = parse_qs(parts.query)
        assert query["client_id"] == [CLIENT_ID]
        assert query["post_logout_redirect_uri"] == ["http://localhost/signed-out"]
        assert query["id_token_hint"][0].count(".") == 2
        assert client.get("/api/v1/auth/me").status_code == 401


def test_logout_stays_local_when_the_provider_has_no_end_session_endpoint(fake):
    fake.config.advertise_end_session = False
    with TestClient(app=make_oidc_app(fake, logout_idp=True)) as client:
        oidc_login(client, fake)
        assert client.post("/api/v1/auth/logout").json() == {"redirectTo": None}


def test_logout_never_redirects_a_password_session(fake):
    with TestClient(app=make_oidc_app(fake, logout_idp=True)) as client:
        client.post("/api/v1/auth/login", json=CREDS)
        assert client.post("/api/v1/auth/logout").json() == {"redirectTo": None}
