"""OIDC through the auth endpoints, against the in-process fake provider."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
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
from tests.oidc_fake import CLIENT_ID, CLIENT_SECRET, ISSUER, REDIRECT_URI, FakeIdp, make_fake_idp
from tests.test_auth_endpoints import make_app, make_disabled_app, protected

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


@pytest.mark.xfail(strict=True, reason="start endpoint lands in Task 6")
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


@pytest.mark.xfail(strict=True, reason="start endpoint lands in Task 6")
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
