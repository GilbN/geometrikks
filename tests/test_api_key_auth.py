"""Bearer API keys next to the session cookie: authentication, scope guards, logging."""

from __future__ import annotations

from collections.abc import Callable, MutableMapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from litestar import Litestar, Router, head, post, route
from litestar.channels import ChannelsPlugin
from litestar.di import Provide
from litestar.exceptions import WebSocketDisconnect
from litestar.testing import AsyncTestClient, TestClient
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from geometrikks.domain.abuseipdb.controllers import AbuseIpdbController
from geometrikks.domain.auth.api_keys import ApiKeyScope
from geometrikks.domain.security.controllers import CrowdSecController
from geometrikks.server import runtime
from geometrikks.server.api_key_store import ApiKeyStore
from geometrikks.server.routes import API_V1_PREFIX
from tests.api_key_support import MemoryApiKeyRepository
from tests.test_auth_endpoints import _ws_event, make_app, make_disabled_app

pytestmark = pytest.mark.anyio

CREDS = {"username": "admin", "password": "bestpasswordintheworldnojoke"}
UNKNOWN_KEY = "gmk_" + "A" * 43


@post("/api/v1/test-write")
async def write_handler() -> dict[str, bool]:
    return {"written": True}


@route("/api/v1/test-methods", http_method=["PUT", "PATCH", "DELETE"], status_code=200)
async def methods_handler() -> dict[str, bool]:
    return {"written": True}


@head("/api/v1/test-head")
async def head_handler() -> None:
    return None


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def key_store(app: Litestar) -> ApiKeyStore:
    store = runtime.get_api_key_store(app)
    assert store is not None
    return store


async def create_key(app: Litestar, *, scope: ApiKeyScope = "read", name: str = "homepage", expires_at: datetime | None = None) -> str:
    _, api_key = await key_store(app).create(name=name, scope=scope, expires_at=expires_at, created_by="admin")
    return api_key


def rejections(captured_logs: Sequence[MutableMapping[str, Any]]) -> list[MutableMapping[str, Any]]:
    return [log_event for log_event in captured_logs if log_event["event"] == "api_key_rejected"]


def key_app(**kwargs: Any) -> Litestar:
    return make_app(extra_handlers=[write_handler, methods_handler, head_handler], **kwargs)


def expire_keys(app: Litestar) -> None:
    store = key_store(app)
    later = store.clock() + timedelta(days=2)
    store.clock = lambda: later


async def test_read_key_reads_protected_route():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 200
    assert res.json() == {"ok": True}


async def test_head_with_read_key_allowed():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.head("/api/v1/test-head", headers=bearer(api_key))
        anonymous = await client.head("/api/v1/test-head")
        unknown = await client.head("/api/v1/test-head", headers=bearer(UNKNOWN_KEY))
    assert res.status_code == 200
    assert anonymous.status_code == 401
    assert unknown.status_code == 401


@pytest.mark.parametrize(
    "header_for",
    [
        lambda api_key: f"bearer {api_key}",
        lambda api_key: f"BEARER {api_key}",
        lambda api_key: f"  Bearer   {api_key}  ",
    ],
    ids=["lowercase", "uppercase", "padded"],
)
async def test_lowercase_bearer_scheme_accepted(header_for: Callable[[str], str]):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.get("/api/v1/protected", headers={"Authorization": header_for(api_key)})
    assert res.status_code == 200


@pytest.mark.parametrize(
    ("token", "reason"),
    [
        (UNKNOWN_KEY, "unknown"),
        ("gmk_", "malformed"),
        ("gmk_" + "A" * 42, "malformed"),
        ("gmk_" + "A" * 42 + "!", "malformed"),
        ("gmk_" + "A" * 44, "malformed"),
    ],
    ids=["unknown", "bare-prefix", "short", "bad-character", "long"],
)
async def test_unknown_malformed_and_bare_prefix_tokens_are_401(token: str, reason: str):
    app = key_app()
    with capture_logs() as captured_logs:
        async with AsyncTestClient(app=app) as client:
            res = await client.get("/api/v1/protected", headers=bearer(token))
    assert res.status_code == 401
    assert res.json()["detail"] == "Invalid API key"
    assert res.json()["code"] == "api_key_invalid"
    [rejection] = rejections(captured_logs)
    assert rejection["user"] == token[:8]
    assert rejection["reason"] == reason
    assert rejection["log_level"] == "warning"
    assert "key" not in rejection


async def test_expired_key_is_401_and_logs_its_name():
    app = key_app()
    with capture_logs() as captured_logs:
        async with AsyncTestClient(app=app) as client:
            api_key = await create_key(app, name="test-curl", expires_at=datetime.now(UTC) + timedelta(hours=1))
            expire_keys(app)
            res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 401
    assert res.json()["detail"] == "API key expired"
    assert res.json()["code"] == "api_key_expired"
    [rejection] = rejections(captured_logs)
    assert rejection["user"] == api_key[:8]
    assert rejection["key"] == "test-curl"
    assert rejection["reason"] == "expired"
    assert rejection["ip"]


async def test_rejections_never_log_the_full_key():
    app = key_app()
    with capture_logs() as captured_logs:
        async with AsyncTestClient(app=app) as client:
            api_key = await create_key(app, expires_at=datetime.now(UTC) + timedelta(hours=1))
            expire_keys(app)
            await client.get("/api/v1/protected", headers=bearer(api_key))
            await client.get("/api/v1/protected", headers=bearer(UNKNOWN_KEY))
    assert captured_logs
    for log_event in captured_logs:
        assert all(api_key not in str(value) and UNKNOWN_KEY not in str(value) for value in log_event.values())


async def test_revoked_key_is_401_on_next_request():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        assert (await client.get("/api/v1/protected", headers=bearer(api_key))).status_code == 200
        [api_key_record] = await key_store(app).list_records()
        await key_store(app).revoke(api_key_record.id)
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 401


@pytest.mark.parametrize(
    "headers_for",
    [
        lambda token: [("Authorization", "Bearer some.jwt.value"), ("Authorization", f"Bearer {token}")],
        lambda token: [("Authorization", f"Bearer some.jwt.value, Bearer {token}")],
    ],
    ids=["repeated-header", "comma-joined"],
)
async def test_key_behind_another_bearer_still_decides(headers_for: Callable[[str], list[tuple[str, str]]]):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        read_key_post = await client.post("/api/v1/test-write", headers=headers_for(api_key))
        bad_key_get = await client.get("/api/v1/protected", headers=headers_for("gmk_bad"))
        session_me = await client.get("/api/v1/auth/me")
    assert read_key_post.status_code == 403
    assert bad_key_get.status_code == 401
    assert session_me.status_code == 200


async def test_two_api_keys_in_one_request_are_rejected():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        first_key = await create_key(app, name="first")
        second_key = await create_key(app, name="second")
        res = await client.get(
            "/api/v1/protected",
            headers=[("Authorization", f"Bearer {first_key}"), ("Authorization", f"Bearer {second_key}")],
        )
    assert res.status_code == 401


async def test_non_gmk_bearer_falls_through_to_cookie():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        assert (await client.get("/api/v1/protected", headers=bearer("some.jwt.value"))).status_code == 401
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        res = await client.get("/api/v1/protected", headers=bearer("some.jwt.value"))
    assert res.status_code == 200


@pytest.mark.parametrize("token_kind", ["unknown", "malformed", "expired"])
async def test_bad_key_with_valid_cookie_keeps_the_session(token_kind: str):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        session_id = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        if token_kind == "expired":
            token = await create_key(app, expires_at=datetime.now(UTC) + timedelta(hours=1))
            expire_keys(app)
        else:
            token = UNKNOWN_KEY if token_kind == "unknown" else "gmk_bad"
        rejected = await client.get("/api/v1/protected", headers=bearer(token))
        assert rejected.status_code == 401
        assert "set-cookie" not in rejected.headers
        assert await app.stores.get("sessions").get(session_id) is not None
        assert (await client.get("/api/v1/protected")).status_code == 200


async def test_valid_key_with_valid_cookie_keeps_the_session():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        session_id = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        api_key = await create_key(app)
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
        assert res.status_code == 200
        assert "set-cookie" not in res.headers
        assert await app.stores.get("sessions").get(session_id) is not None
        assert (await client.get("/api/v1/auth/me")).status_code == 200


async def test_read_key_with_valid_cookie_cannot_post():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        api_key = await create_key(app)
        res = await client.post("/api/v1/test-write", headers=bearer(api_key))
    assert res.status_code == 403


async def test_key_request_sets_no_cookie():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        accepted = await client.get("/api/v1/protected", headers=bearer(api_key))
        rejected = await client.get("/api/v1/protected", headers=bearer(UNKNOWN_KEY))
    assert accepted.status_code == 200
    assert "set-cookie" not in accepted.headers
    assert rejected.status_code == 401
    assert "set-cookie" not in rejected.headers


async def test_read_key_cannot_post():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.post("/api/v1/test-write", headers=bearer(api_key))
    assert res.status_code == 403
    assert res.json()["detail"] == "This API key is read-only"
    assert res.json()["code"] == "api_key_read_only"


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_read_key_cannot_use_other_write_methods(method: str):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.request(method, "/api/v1/test-methods", headers=bearer(api_key))
    assert res.status_code == 403


async def test_read_key_cannot_ban_networks():
    crowdsec_router = Router(
        path=API_V1_PREFIX,
        route_handlers=[CrowdSecController],
        dependencies={"db_session": Provide(lambda: AsyncMock(spec=AsyncSession), sync_to_thread=False)},
    )
    app = make_app(extra_handlers=[crowdsec_router])
    ban_body = {"networks": ["192.0.2.0/24"], "duration": "7d"}
    async with AsyncTestClient(app=app) as client:
        read_key = await create_key(app, name="dashboard")
        read_attempt = await client.post("/api/v1/crowdsec/ban-networks", json=ban_body, headers=bearer(read_key))
    assert read_attempt.status_code == 403


def abuseipdb_app() -> Litestar:
    abuseipdb_router = Router(
        path=API_V1_PREFIX,
        route_handlers=[AbuseIpdbController],
        dependencies={"db_session": Provide(lambda: AsyncMock(spec=AsyncSession, bind=MagicMock()), sync_to_thread=False)},
    )
    return make_app(extra_handlers=[abuseipdb_router])


async def test_read_key_reads_abuseipdb_status_but_cannot_report():
    app = abuseipdb_app()
    report_body = {
        "reports": [
            {"ipAddress": "3.5.140.2", "categories": [18], "comment": "probing", "attackTime": "2026-11-06T14:02:00Z"}
        ]
    }
    async with AsyncTestClient(app=app) as client:
        read_key = await create_key(app, name="dashboard")
        report_attempt = await client.post("/api/v1/abuseipdb/reports", json=report_body, headers=bearer(read_key))
        status = await client.get("/api/v1/abuseipdb/status", headers=bearer(read_key))
    assert report_attempt.status_code == 403
    assert report_attempt.json()["code"] == "api_key_read_only"
    assert status.status_code == 200


async def test_abuseipdb_blacklist_needs_credentials():
    async with AsyncTestClient(app=abuseipdb_app()) as client:
        res = await client.get("/api/v1/abuseipdb/blacklist")
    assert res.status_code == 401


async def test_read_key_reads_the_abuseipdb_blacklist():
    app = abuseipdb_app()
    async with AsyncTestClient(app=app) as client:
        read_key = await create_key(app, name="dashboard")
        res = await client.get("/api/v1/abuseipdb/blacklist", headers=bearer(read_key))
    assert res.status_code == 200
    assert res.json() == {"generatedAt": None, "refreshedAt": None, "ips": []}


async def test_read_write_key_can_post():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app, scope="read_write")
        posted = await client.post("/api/v1/test-write", headers=bearer(api_key))
        deleted = await client.delete("/api/v1/test-methods", headers=bearer(api_key))
    assert posted.status_code == 201
    assert posted.json() == {"written": True}
    assert deleted.status_code == 200


def test_read_key_opens_ws_live():
    from tests.test_live_ws import publish_once_subscribed

    app = make_app()
    with TestClient(app=app) as client:
        api_key = client.blocking_portal.call(lambda: create_key(app))
        channels = app.plugins.get(ChannelsPlugin)
        with client.websocket_connect("/ws/live", headers=bearer(api_key)) as ws:
            publish_once_subscribed(client, channels, _ws_event())
            frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"


def test_unknown_key_ws_is_rejected():
    with TestClient(app=make_app()) as client:
        with pytest.raises(WebSocketDisconnect) as disconnect:
            with client.websocket_connect("/ws/live", headers=bearer(UNKNOWN_KEY)) as ws:
                ws.receive_json(timeout=10)
    assert disconnect.value.detail == "Invalid API key"


@pytest.mark.parametrize("scope", ["read", "read_write"])
@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", "/api/v1/auth/me"), ("POST", "/api/v1/auth/logout"), ("GET", "/api/v1/auth/oidc/status")],
)
async def test_any_key_is_403_on_me_logout_and_oidc_status(scope: ApiKeyScope, method: str, path: str):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app, scope=scope)
        res = await client.request(method, path, headers=bearer(api_key))
    assert res.status_code == 403


async def test_key_logout_leaves_the_cookie_session_alone():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        session_id = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        api_key = await create_key(app, scope="read_write")
        res = await client.post("/api/v1/auth/logout", headers=bearer(api_key))
        assert res.status_code == 403
        assert await app.stores.get("sessions").get(session_id) is not None


async def test_session_user_still_reaches_me_logout_and_oidc_status():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        assert (await client.get("/api/v1/auth/me")).status_code == 200
        assert (await client.get("/api/v1/auth/oidc/status")).status_code == 200
        assert (await client.post("/api/v1/auth/logout")).status_code == 200


@pytest.mark.parametrize("path", ["/api/v1/protected", "/api/v1/test-write"])
async def test_options_request_passes_guards(path: str):
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.options(path, headers=bearer(api_key))
    assert res.status_code == 204


async def test_store_outage_is_503():
    app = key_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        app.state.session_store_ready = False
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 503
    assert res.json()["code"] == "api_keys_unavailable"


async def test_repository_outage_is_503():
    repository = MemoryApiKeyRepository()
    app = key_app(api_key_repository=repository)
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        repository.find_error = OSError("connection refused")
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 503
    assert res.json()["code"] == "api_keys_unavailable"


async def test_missing_store_is_503():
    app = key_app()
    del app.state.api_key_store
    async with AsyncTestClient(app=app) as client:
        res = await client.get("/api/v1/protected", headers=bearer(UNKNOWN_KEY))
    assert res.status_code == 503
    assert res.json()["code"] == "api_keys_unavailable"


async def test_rejection_lines_are_throttled():
    app = key_app()
    with capture_logs() as captured_logs:
        async with AsyncTestClient(app=app) as client:
            for _ in range(3):
                assert (await client.get("/api/v1/protected", headers=bearer(UNKNOWN_KEY))).status_code == 401
    assert len(rejections(captured_logs)) == 1


async def test_last_used_is_recorded():
    repository = MemoryApiKeyRepository()
    app = key_app(api_key_repository=repository)
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        assert (await client.get("/api/v1/protected", headers=bearer(api_key))).status_code == 200
    [api_key_record] = await repository.list_records()
    assert len(repository.touches) == 1
    assert api_key_record.last_used_at is not None
    assert api_key_record.last_used_ip == repository.touches[0][2]
    assert api_key_record.last_used_ip


async def test_failed_last_used_write_still_serves_the_request():
    repository = MemoryApiKeyRepository()
    repository.touch_error = OSError("connection refused")
    app = key_app(api_key_repository=repository)
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app)
        res = await client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 200


async def test_openapi_lists_both_schemes():
    async with AsyncTestClient(app=key_app()) as client:
        schema = (await client.get("/schema/openapi.json")).json()
    api_key_scheme = schema["components"]["securitySchemes"]["apiKey"]
    assert api_key_scheme["type"] == "http"
    assert api_key_scheme["scheme"] == "bearer"
    assert "sessionCookie" in schema["components"]["securitySchemes"]
    assert schema["security"] == [{"sessionCookie": []}, {"apiKey": []}]


async def test_auth_disabled_app_ignores_bearer_headers():
    async with AsyncTestClient(app=make_disabled_app()) as client:
        read = await client.get("/api/v1/protected", headers=bearer(UNKNOWN_KEY))
        me = await client.get("/api/v1/auth/me", headers=bearer(UNKNOWN_KEY))
    assert read.status_code == 200
    assert me.status_code == 200


async def test_login_ignores_a_stray_key_header():
    async with AsyncTestClient(app=key_app()) as client:
        res = await client.post("/api/v1/auth/login", json=CREDS, headers=bearer(UNKNOWN_KEY))
    assert res.status_code == 200
