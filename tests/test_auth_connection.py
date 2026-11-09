"""Connection tests use the real authentication middleware and in-memory stores."""

from datetime import UTC, datetime, timedelta

import pytest
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import CrowdSecSettings, DropSettings, GeoIPSettings, get_installed_version
from tests.test_api_key_auth import CREDS, UNKNOWN_KEY, bearer, create_key, expire_keys, key_app
from tests.test_auth_endpoints import make_disabled_app

pytestmark = pytest.mark.anyio
PATH = "/api/v1/auth/connection"


@pytest.mark.parametrize("scope", ["read", "read_write"])
async def test_connection_reports_only_the_current_keys_metadata(scope):
    app = key_app()
    expires_at = datetime.now(UTC) + timedelta(hours=1)
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app, name="homarr", scope=scope, expires_at=expires_at)
        response = await client.get(PATH, headers=bearer(key))
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert "set-cookie" not in response.headers
    body = response.json()
    assert body["mode"] == "apiKey"
    assert body["name"] == "homarr"
    assert body["scope"] == scope
    assert datetime.fromisoformat(body["expiresAt"]) == expires_at
    assert body["appVersion"] == get_installed_version()
    assert body["apiVersion"] == "1"
    assert key not in response.text
    assert set(body) == {"mode", "name", "scope", "expiresAt", "appVersion", "apiVersion", "capabilities"}


async def test_connection_reports_a_key_without_expiry():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app)
        response = await client.get(PATH, headers=bearer(key))
    assert response.json()["expiresAt"] is None


@pytest.mark.parametrize("credentials", [None, UNKNOWN_KEY])
async def test_connection_rejects_missing_or_invalid_credentials(credentials):
    async with AsyncTestClient(app=key_app()) as client:
        response = await client.get(PATH, headers=bearer(credentials) if credentials else {})
    assert response.status_code == 401
    assert response.json()["code"] == ("api_key_invalid" if credentials else "not_authenticated")


async def test_expired_keys_fail_before_connection_metadata_is_returned():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app, expires_at=datetime.now(UTC) + timedelta(hours=1))
        expire_keys(app)
        response = await client.get(PATH, headers=bearer(key))
    assert response.status_code == 401
    assert response.json()["code"] == "api_key_expired"
    assert "name" not in response.json()


async def test_session_connection_has_no_key_fields():
    async with AsyncTestClient(app=key_app()) as client:
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        response = await client.get(PATH)
    assert response.status_code == 200
    assert response.json()["mode"] == "session"
    assert set(response.json()) == {"mode", "appVersion", "apiVersion", "capabilities"}


async def test_disabled_auth_does_not_claim_to_validate_a_supplied_key():
    async with AsyncTestClient(app=make_disabled_app()) as client:
        response = await client.get(PATH, headers=bearer(UNKNOWN_KEY))
    assert response.status_code == 200
    assert response.json()["mode"] == "disabled"
    assert "scope" not in response.json()


@pytest.mark.parametrize("write", [False, True])
async def test_capabilities_describe_settings_without_contacting_upstreams(write):
    crowdsec = CrowdSecSettings(
        lapi_url="http://unused.invalid", bouncer_api_key="bouncer",
        machine_id="machine" if write else None, machine_password="password" if write else None,
    )
    app = key_app(crowdsec=crowdsec, geoip=GeoIPSettings(asn_enabled=False), drop=DropSettings(enabled=False))
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app)
        response = await client.get(PATH, headers=bearer(key))
    assert response.status_code == 200
    assert response.json()["capabilities"] == (["crowdsec", "crowdsecWrite"] if write else ["crowdsec"])


async def test_connection_returns_a_coded_store_outage():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        key = await create_key(app)
        app.state.session_store_ready = False
        response = await client.get(PATH, headers=bearer(key))
    assert response.status_code == 503
    assert response.json()["code"] == "api_keys_unavailable"
