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


@pytest.mark.parametrize(
    ("configured", "advertised"),
    [(f"{ISSUER}/", ISSUER), (ISSUER, f"{ISSUER}/")],
    ids=["slash-in-config", "slash-at-provider"],
)
async def test_issuer_trailing_slash_is_forgiven_and_tokens_use_the_providers_spelling(
    fake, configured, advertised
):
    fake.config.issuer = advertised
    client = OidcClient(oidc_settings(issuer=configured), fake.http_client())
    assert (await client.metadata()).issuer == advertised
    assert (await login(client, fake)).identity.username == "gil"


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


import base64
import hashlib
from urllib.parse import parse_qs, parse_qsl, urlsplit

from geometrikks.services.oidc import (
    OidcCompletion,
    OidcForbidden,
    OidcProtocolError,
    PendingLogin,
    build_identity,
    check_allow_list,
)
from geometrikks.services.oidc import client as client_module


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


async def login(client: OidcClient, fake: FakeIdp) -> OidcCompletion:
    url, pending = await client.begin()
    callback = await fake.visit_authorize(url)
    query = dict(parse_qsl(urlsplit(callback).query))
    return await client.complete(query["code"], pending)


async def test_begin_builds_a_pkce_authorize_url(client, fake):
    url, pending = await client.begin()
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == fake.config.url("/authorize")
    query = parse_qs(parts.query)
    assert query["response_type"] == ["code"]
    assert query["client_id"] == [CLIENT_ID]
    assert query["redirect_uri"] == [REDIRECT_URI]
    assert query["scope"] == ["openid profile email groups"]
    assert query["state"] == [pending.state]
    assert query["nonce"] == [pending.nonce]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] == [_s256(pending.code_verifier)]
    assert pending.code_verifier not in url
    assert len(pending.state) == len(pending.nonce) == len(pending.code_verifier) == 43
    assert pending.expired() is False


async def test_begin_retries_discovery_after_a_startup_failure(client, fake):
    fake.config.fail["discovery"] = 500
    await client.warm_up()
    del fake.config.fail["discovery"]
    url, _ = await client.begin()
    assert url.startswith(fake.config.url("/authorize"))


async def test_pending_login_round_trips_through_the_session_and_expires(monkeypatch):
    pending = PendingLogin(state="s" * 43, nonce="n" * 43, code_verifier="v" * 43, created_at=1000.0)
    restored = PendingLogin.from_session(pending.to_session())
    assert restored == pending
    assert PendingLogin.from_session(None) is None
    assert PendingLogin.from_session({"state": "x"}) is None
    assert pending.expired(now=1000.0 + 599) is False
    assert pending.expired(now=1000.0 + 601) is True
    assert pending.matches_state("s" * 43) is True
    assert pending.matches_state("t" * 43) is False
    assert pending.matches_state(None) is False


async def test_happy_path_returns_identity_and_id_token(client, fake):
    completion = await login(client, fake)
    identity = completion.identity
    assert identity.subject == "user-1"
    assert identity.username == "gil"
    assert identity.email == "gil@example.com"
    assert identity.email_verified is True
    assert identity.groups == ("admins",)
    assert completion.id_token.count(".") == 2
    sent = fake.config.token_requests[0]
    assert sent["grant_type"] == "authorization_code"
    assert sent["redirect_uri"] == REDIRECT_URI
    assert sent["authorization"].startswith("Basic ")
    assert "client_secret" not in sent


async def test_client_secret_post_when_the_provider_only_supports_it(fake):
    fake.config.token_auth_methods = ["client_secret_post"]
    client = OidcClient(oidc_settings(), fake.http_client())
    await login(client, fake)
    sent = fake.config.token_requests[0]
    assert sent["client_secret"] == CLIENT_SECRET
    assert sent["authorization"] == ""


@pytest.mark.parametrize(
    ("knobs", "reason"),
    [
        ({"claims": {"iss": "http://127.0.0.1:9/other"}}, "id_token_invalid"),
        ({"claims": {"aud": "someone-else"}}, "id_token_invalid"),
        ({"claims": {"aud": [CLIENT_ID, "other"]}}, "id_token_invalid"),
        ({"claims": {"aud": [CLIENT_ID, "other"], "azp": "other"}}, "id_token_invalid"),
        ({"claims": {"azp": "other"}}, "id_token_invalid"),
        ({"claims": {"sub": ""}}, "id_token_invalid"),
        ({"expires_in": -120}, "id_token_invalid"),
        ({"iat_offset": 120}, "id_token_invalid"),
        ({"claims": {"exp": []}}, "id_token_invalid"),
        ({"claims": {"iat": {}}}, "id_token_invalid"),
        ({"claims": {"exp": 1e400}}, "id_token_invalid"),
        ({"claims": {"iat": 1e400}}, "id_token_invalid"),
        ({"claims": {"nonce": "not-the-one-we-sent"}}, "nonce_mismatch"),
        ({"signing": "none"}, "id_token_invalid"),
        ({"signing": "hs256"}, "id_token_invalid"),
        ({"signing": "rsa-other"}, "id_token_invalid"),
        ({"advertised_algorithms": ["ES256"]}, "id_token_invalid"),
        ({"token_kid": "ghost"}, "id_token_invalid"),
        ({"claims": {"pad": "x" * 17_000}}, "id_token_invalid"),
        ({"token_type": "mac"}, "token_exchange"),
        ({"include_id_token": False}, "token_exchange"),
        ({"token_response_json": False}, "token_exchange"),
        ({"fail": {"token": 500}}, "token_exchange"),
        ({"fail": {"token": 302}}, "token_exchange"),
        ({"fail": {"userinfo": 500}}, "userinfo"),
        ({"fail": {"userinfo": 302}}, "userinfo"),
        ({"userinfo": {"sub": "someone-else", "groups": ["admins"]}}, "userinfo"),
    ],
)
async def test_rejections(fake, knobs, reason):
    for name, value in knobs.items():
        setattr(fake.config, name, value)
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcProtocolError) as excinfo:
        await login(client, fake)
    assert excinfo.value.reason == reason


async def test_unknown_kid_refetches_the_jwks_once(client, fake):
    await login(client, fake)
    assert fake.config.jwks_fetches == 1
    fake.config.kid = "key-2"
    await login(client, fake)
    assert fake.config.jwks_fetches == 2
    fake.config.token_kid = "ghost"
    with pytest.raises(OidcProtocolError, match="unknown signing key"):
        await login(client, fake)
    assert fake.config.jwks_fetches == 3


async def test_missing_kid_is_rejected_before_any_jwks_fetch(fake):
    fake.config.token_kid = ""
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcProtocolError, match="kid"):
        await login(client, fake)
    assert fake.config.jwks_fetches == 0


async def test_malformed_jwks_is_unavailable_not_a_crash(fake):
    fake.config.jwks_document = {"keys": [1]}
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcUnavailable, match="JWKS is malformed"):
        await login(client, fake)


@pytest.mark.parametrize(
    ("signing", "algorithm"), [("rsa", "RS256"), ("ps256", "PS256"), ("rsa384", "RS384")]
)
async def test_alg_less_jwk_verifies_any_advertised_algorithm(fake, signing, algorithm):
    # JWK alg is optional (RFC 7517 4.4). PyJWT gives an alg-less RSA JWK
    # algorithm_name RS256, so decoding with the PyJWK object rejects PS256
    # and RS384; the client passes the raw key instead.
    fake.config.jwks_alg = None
    fake.config.signing = signing
    fake.config.advertised_algorithms = [algorithm]
    client = OidcClient(oidc_settings(), fake.http_client())
    completion = await login(client, fake)
    assert completion.identity.subject == "user-1"


async def test_jwk_alg_mismatched_with_the_token_is_rejected(fake):
    fake.config.jwks_alg = "RS256"
    fake.config.signing = "ps256"
    fake.config.advertised_algorithms = ["RS256", "PS256"]
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcProtocolError) as excinfo:
        await login(client, fake)
    assert excinfo.value.reason == "id_token_invalid"


async def test_pending_expiry_follows_the_module_clock(client, monkeypatch):
    # complete() does not check the age; the callback does, through
    # expired(), before spending the code. Pin the clock the callback uses.
    _, pending = await client.begin()
    assert pending.expired() is False
    monkeypatch.setattr(client_module, "_now", lambda: pending.created_at + 601)
    assert pending.expired() is True


# Claim merging: email and email_verified travel as a pair from one document.


def _claims(**overrides) -> dict:
    return {"sub": "user-1", **overrides}


def test_email_pair_comes_from_userinfo_when_it_has_an_email():
    identity = build_identity(
        _claims(email_verified=True),
        {"sub": "user-1", "email": "gil@example.com", "email_verified": False},
        groups_claim="groups",
    )
    assert identity.email == "gil@example.com"
    assert identity.email_verified is False


def test_email_pair_comes_from_the_id_token_otherwise():
    identity = build_identity(
        _claims(email="gil@example.com", email_verified=True), {"sub": "user-1"}, groups_claim="groups"
    )
    assert identity.email == "gil@example.com"
    assert identity.email_verified is True


def test_email_verified_as_a_string_does_not_count():
    identity = build_identity(
        _claims(), {"sub": "user-1", "email": "gil@example.com", "email_verified": "true"},
        groups_claim="groups",
    )
    assert identity.email_verified is False


def test_conflicting_emails_are_a_protocol_error():
    with pytest.raises(OidcProtocolError) as excinfo:
        build_identity(
            _claims(email="one@example.com"), {"sub": "user-1", "email": "two@example.com"},
            groups_claim="groups",
        )
    assert excinfo.value.reason == "claims"


def test_same_email_in_different_case_is_not_a_conflict():
    identity = build_identity(
        _claims(email="Gil@Example.com"), {"sub": "user-1", "email": "gil@example.com"},
        groups_claim="groups",
    )
    assert identity.email == "gil@example.com"


def test_groups_prefer_userinfo_then_id_token_and_accept_a_single_string():
    assert build_identity(_claims(groups=["a"]), {"sub": "user-1", "groups": ["b"]}, groups_claim="groups").groups == ("b",)
    assert build_identity(_claims(groups=["a"]), {"sub": "user-1"}, groups_claim="groups").groups == ("a",)
    assert build_identity(_claims(), {"sub": "user-1"}, groups_claim="groups").groups == ()
    assert build_identity(_claims(roles="admin"), {"sub": "user-1"}, groups_claim="roles").groups == ("admin",)


def test_groups_null_in_userinfo_falls_back_to_the_id_token():
    identity = build_identity(
        _claims(groups=["admins"]),
        {"sub": "user-1", "groups": None},
        groups_claim="groups",
    )
    assert identity.groups == ("admins",)
    # The allow list check must see those groups, not an empty tuple.
    check_allow_list(identity, allowed_users=[], allowed_groups=["admins"])


def test_username_fallback_chain():
    assert build_identity(_claims(), {"sub": "user-1"}, groups_claim="groups").username == "user-1"
    assert build_identity(_claims(name="Gil B"), {"sub": "user-1"}, groups_claim="groups").username == "Gil B"
    assert build_identity(_claims(name="Gil B"), {"sub": "user-1", "preferred_username": "gil"}, groups_claim="groups").username == "gil"
    assert build_identity(_claims(), {"sub": "user-1", "email": "gil@example.com"}, groups_claim="groups").username == "gil@example.com"


def test_userinfo_sub_must_match():
    with pytest.raises(OidcProtocolError) as excinfo:
        build_identity(_claims(), {"sub": "other"}, groups_claim="groups")
    assert excinfo.value.reason == "userinfo"


# Allow list.


def _identity(**overrides):
    from geometrikks.services.oidc import OidcIdentity

    values = dict(subject="user-1", username="gil", email="gil@example.com", email_verified=True, groups=("admins",))
    values.update(overrides)
    return OidcIdentity(**values)  # ty: ignore[invalid-argument-type]


def test_allow_list_subject_match():
    check_allow_list(_identity(groups=()), allowed_users=["user-1"], allowed_groups=[])


def test_allow_list_verified_email_match_is_case_insensitive():
    check_allow_list(_identity(groups=(), email="Gil@Example.com"), allowed_users=["gil@example.com"], allowed_groups=[])


def test_allow_list_unverified_email_never_matches():
    with pytest.raises(OidcForbidden):
        check_allow_list(_identity(groups=(), email_verified=False), allowed_users=["gil@example.com"], allowed_groups=[])


def test_allow_list_group_overlap():
    check_allow_list(_identity(groups=("family", "admins")), allowed_users=[], allowed_groups=["admins"])


def test_allow_list_denial_carries_the_evidence():
    with pytest.raises(OidcForbidden) as excinfo:
        check_allow_list(_identity(groups=("guests",)), allowed_users=["someone@example.com"], allowed_groups=["admins"])
    assert excinfo.value.subject == "user-1"
    assert excinfo.value.email == "gil@example.com"
    assert excinfo.value.groups == ("guests",)


async def test_login_applies_the_allow_list(fake):
    fake.config.userinfo["groups"] = ["guests"]
    client = OidcClient(oidc_settings(), fake.http_client())
    with pytest.raises(OidcForbidden):
        await login(client, fake)


# IdP logout URL.


async def test_end_session_url(client, fake):
    assert client.end_session_url("tok", "http://localhost/signed-out") is None
    await client.metadata()
    url = client.end_session_url("tok", "http://localhost/signed-out")
    assert url is not None
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == fake.config.url("/end-session")
    query = parse_qs(parts.query)
    assert query == {
        "id_token_hint": ["tok"],
        "client_id": [CLIENT_ID],
        "post_logout_redirect_uri": ["http://localhost/signed-out"],
    }


async def test_end_session_url_is_none_when_not_advertised(fake):
    fake.config.advertise_end_session = False
    client = OidcClient(oidc_settings(), fake.http_client())
    await client.metadata()
    assert client.end_session_url("tok", "http://localhost/signed-out") is None
