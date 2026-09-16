"""OIDC client: discovery, JWKS, transport rules, ID token validation, allow list."""
from __future__ import annotations

import pytest

from geometrikks.config.settings import OidcSettings
from geometrikks.services.oidc import OidcClient, OidcUnavailable
from tests.oidc_fake import CLIENT_ID, CLIENT_SECRET, ISSUER, REDIRECT_URI, FakeIdp, make_fake_idp

pytestmark = pytest.mark.anyio


def oidc_settings(**overrides) -> OidcSettings:
    values: dict = dict(
        issuer=ISSUER,
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        redirect_uri=REDIRECT_URI,
        allowed_groups=["admins"],
    )
    values.update(overrides)
    return OidcSettings(_env_file=None, **values)


@pytest.fixture
def fake() -> FakeIdp:
    return make_fake_idp()


@pytest.fixture
async def client(fake: FakeIdp):
    oidc = OidcClient(oidc_settings(), fake.http_client())
    yield oidc
    await oidc.aclose()


async def test_discovery_is_fetched_once_and_cached(client, fake):
    first = await client.metadata()
    second = await client.metadata()
    assert first is second
    assert fake.config.discovery_fetches == 1
    assert first.authorization_endpoint == fake.config.url("/authorize")
    assert first.end_session_endpoint == fake.config.url("/end-session")
    assert first.algorithms == frozenset({"RS256"})
    assert first.token_auth_post is False
    assert client.last_error is None
    assert client.metadata_cached is first


async def test_discovery_failure_is_retried_on_the_next_call(client, fake):
    fake.config.fail["discovery"] = 500
    with pytest.raises(OidcUnavailable, match="HTTP 500"):
        await client.metadata()
    assert client.last_error is not None
    assert client.metadata_cached is None
    del fake.config.fail["discovery"]
    assert (await client.metadata()).issuer == ISSUER
    assert client.last_error is None
    assert fake.config.discovery_fetches == 2


async def test_warm_up_never_raises(client, fake):
    fake.config.fail["discovery"] = 500
    await client.warm_up()
    assert client.metadata_cached is None
    assert client.last_error is not None


async def test_discovery_issuer_mismatch_is_rejected(fake):
    fake.config.issuer = "http://127.0.0.1:9/other"
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcUnavailable, match="does not match OIDC_ISSUER"):
        await client.metadata()


async def test_discovery_redirect_is_a_failure(client, fake):
    fake.config.fail["discovery"] = 302
    with pytest.raises(OidcUnavailable, match="HTTP 302"):
        await client.metadata()


async def test_oversized_discovery_document_is_a_failure(client, fake):
    fake.config.oversized.add("discovery")
    with pytest.raises(OidcUnavailable, match="exceeds"):
        await client.metadata()


async def test_http_endpoints_off_loopback_are_rejected(client, fake):
    fake.config.endpoint_host = "idp.example.com"
    with pytest.raises(OidcUnavailable, match="must use https"):
        await client.metadata()


async def test_end_session_endpoint_is_optional(client, fake):
    fake.config.advertise_end_session = False
    assert (await client.metadata()).end_session_endpoint is None


async def test_no_supported_algorithm_is_a_failure(client, fake):
    fake.config.advertised_algorithms = ["HS256"]
    with pytest.raises(OidcUnavailable, match="no supported"):
        await client.metadata()


async def test_client_secret_post_is_used_only_when_basic_is_not_advertised(fake):
    fake.config.token_auth_methods = ["client_secret_post"]
    client = OidcClient(oidc_settings(), fake.http_client())
    assert (await client.metadata()).token_auth_post is True
    fake.config.token_auth_methods = ["client_secret_post", "client_secret_basic"]
    client = OidcClient(oidc_settings(), fake.http_client())
    assert (await client.metadata()).token_auth_post is False


async def test_discovery_logs_failed_then_loaded(client, fake):
    import structlog

    fake.config.fail["discovery"] = 500
    with structlog.testing.capture_logs() as captured:
        with pytest.raises(OidcUnavailable):
            await client.metadata()
        del fake.config.fail["discovery"]
        await client.metadata()
    assert [e["event"] for e in captured] == ["oidc_discovery_failed", "oidc_discovery_loaded"]


async def test_idp_logout_without_end_session_is_logged_once(fake):
    import structlog

    fake.config.advertise_end_session = False
    client = OidcClient(oidc_settings(logout_idp=True), fake.http_client())
    with structlog.testing.capture_logs() as captured:
        await client.metadata()
        await client.metadata()
    assert [e["event"] for e in captured].count("oidc_idp_logout_unsupported") == 1
