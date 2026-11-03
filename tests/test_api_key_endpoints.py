"""The session-only endpoints that list, create and revoke API keys."""

from __future__ import annotations

import re
from collections.abc import AsyncGenerator, MutableMapping, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from litestar import Litestar, Router
from litestar.testing import AsyncTestClient
from structlog.testing import capture_logs

from geometrikks.domain.auth.api_key_controllers import ApiKeyController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.logging import render_login_line
from geometrikks.server.routes import API_V1_PREFIX
from tests.test_api_key_auth import CREDS, bearer, create_key, expire_keys, key_store
from tests.test_auth_endpoints import make_app, make_disabled_app

pytestmark = pytest.mark.anyio

API_KEYS_PATH = f"{API_V1_PREFIX}/auth/api-keys"
AUTH_DISABLED_DETAIL = "API keys need the built-in login. With APP_AUTH_DISABLED=true the API is already open."


def api_key_router() -> Router:
    return Router(path=API_V1_PREFIX, route_handlers=[ApiKeyController], exception_handlers=EXCEPTION_HANDLERS)


def endpoints_app() -> Litestar:
    return make_app(extra_handlers=[api_key_router()])


@asynccontextmanager
async def logged_in_client(app: Litestar) -> AsyncGenerator[AsyncTestClient]:
    async with AsyncTestClient(app=app) as client:
        assert (await client.post(f"{API_V1_PREFIX}/auth/login", json=CREDS)).status_code == 200
        yield client


def events_named(captured_logs: Sequence[MutableMapping[str, Any]], event: str) -> list[MutableMapping[str, Any]]:
    return [log_event for log_event in captured_logs if log_event["event"] == event]


def in_days(days: int) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).isoformat()


async def test_list_is_newest_first_with_expired_flag():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        first = await client.post(API_KEYS_PATH, json={"name": "first", "expiresAt": in_days(1)})
        second = await client.post(API_KEYS_PATH, json={"name": "second", "scope": "read_write"})
        assert first.status_code == 201
        assert second.status_code == 201
        expire_keys(app)
        res = await client.get(API_KEYS_PATH)
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert [api_key_view["name"] for api_key_view in body["keys"]] == ["second", "first"]
    assert [api_key_view["expired"] for api_key_view in body["keys"]] == [False, True]
    assert body["keys"][0]["scope"] == "read_write"
    assert body["keys"][1]["scope"] == "read"
    assert set(body["keys"][0]) == {
        "id", "name", "scope", "displayPrefix", "createdAt", "createdBy",
        "expiresAt", "lastUsedAt", "lastUsedIp", "expired",
    }


async def test_create_returns_the_key_once():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        created = await client.post(API_KEYS_PATH, json={"name": "  homepage  "})
        listed = await client.get(API_KEYS_PATH)
    assert created.status_code == 201
    created_body = created.json()
    api_key = created_body["key"]
    assert re.fullmatch(r"gmk_[0-9A-Za-z]{43}", api_key)
    api_key_view = created_body["apiKey"]
    assert api_key_view["name"] == "homepage"
    assert api_key_view["scope"] == "read"
    assert api_key_view["createdBy"] == "admin"
    assert api_key_view["displayPrefix"] == api_key[:8]
    assert api_key_view["expiresAt"] is None
    assert api_key_view["expired"] is False
    assert listed.status_code == 200
    assert api_key not in listed.text
    assert [listed_view["id"] for listed_view in listed.json()["keys"]] == [api_key_view["id"]]


async def test_created_key_authenticates():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        api_key = (await client.post(API_KEYS_PATH, json={"name": "homepage"})).json()["key"]
    async with AsyncTestClient(app=app) as anonymous_client:
        res = await anonymous_client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 200


async def test_duplicate_name_ignoring_case_is_409():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        assert (await client.post(API_KEYS_PATH, json={"name": "homepage"})).status_code == 201
        res = await client.post(API_KEYS_PATH, json={"name": "HomePage"})
    assert res.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "past", "expiresAt": in_days(-1)},
        {"name": "naive", "expiresAt": "2099-01-01T00:00:00"},
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 65},
        {"name": "bad-scope", "scope": "admin"},
        {"scope": "read"},
    ],
    ids=["past-expiry", "naive-expiry", "empty-name", "blank-name", "65-char-name", "unknown-scope", "missing-name"],
)
async def test_invalid_create_is_400(payload: dict[str, Any]):
    app = endpoints_app()
    async with logged_in_client(app) as client:
        res = await client.post(API_KEYS_PATH, json=payload)
        listed = await client.get(API_KEYS_PATH)
    assert res.status_code == 400
    assert listed.json()["keys"] == []


async def test_64_char_name_is_accepted():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        res = await client.post(API_KEYS_PATH, json={"name": "x" * 64})
    assert res.status_code == 201


async def test_delete_then_second_delete_is_404():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        api_key = (await client.post(API_KEYS_PATH, json={"name": "homepage"})).json()["key"]
        key_id = (await client.get(API_KEYS_PATH)).json()["keys"][0]["id"]
        first_delete = await client.delete(f"{API_KEYS_PATH}/{key_id}")
        second_delete = await client.delete(f"{API_KEYS_PATH}/{key_id}")
        listed = await client.get(API_KEYS_PATH)
    assert first_delete.status_code == 204
    assert second_delete.status_code == 404
    assert listed.json()["keys"] == []
    async with AsyncTestClient(app=app) as anonymous_client:
        res = await anonymous_client.get("/api/v1/protected", headers=bearer(api_key))
    assert res.status_code == 401


async def test_expired_key_can_be_removed():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        await client.post(API_KEYS_PATH, json={"name": "short", "expiresAt": in_days(1)})
        expire_keys(app)
        key_id = (await client.get(API_KEYS_PATH)).json()["keys"][0]["id"]
        res = await client.delete(f"{API_KEYS_PATH}/{key_id}")
    assert res.status_code == 204


async def test_anonymous_caller_is_401():
    async with AsyncTestClient(app=endpoints_app()) as client:
        res = await client.get(API_KEYS_PATH)
    assert res.status_code == 401


@pytest.mark.parametrize("scope", ["read", "read_write"])
async def test_key_authenticated_caller_is_403_on_every_route(scope):
    app = endpoints_app()
    async with AsyncTestClient(app=app) as client:
        api_key = await create_key(app, scope=scope)
        [api_key_record] = await key_store(app).list_records()
        listed = await client.get(API_KEYS_PATH, headers=bearer(api_key))
        created = await client.post(API_KEYS_PATH, json={"name": "sneaky"}, headers=bearer(api_key))
        deleted = await client.delete(f"{API_KEYS_PATH}/{api_key_record.id}", headers=bearer(api_key))
    assert (listed.status_code, created.status_code, deleted.status_code) == (403, 403, 403)
    assert [stored.name for stored in await key_store(app).list_records()] == ["homepage"]


async def test_key_next_to_a_session_cookie_is_still_403():
    app = endpoints_app()
    async with logged_in_client(app) as client:
        api_key = await create_key(app, scope="read_write")
        res = await client.get(API_KEYS_PATH, headers=bearer(api_key))
    assert res.status_code == 403


async def test_auth_disabled_mode():
    async with AsyncTestClient(app=make_disabled_app(extra_handlers=[api_key_router()])) as client:
        listed = await client.get(API_KEYS_PATH)
        created = await client.post(API_KEYS_PATH, json={"name": "homepage"})
        deleted = await client.delete(f"{API_KEYS_PATH}/00000000-0000-0000-0000-000000000001")
    assert listed.status_code == 200
    assert listed.json() == {"available": False, "keys": []}
    assert created.status_code == 409
    assert created.json()["detail"] == AUTH_DISABLED_DETAIL
    assert deleted.status_code == 409
    assert deleted.json()["detail"] == AUTH_DISABLED_DETAIL


async def test_created_and_revoked_reach_the_login_log():
    app = endpoints_app()
    expires_at = in_days(30)
    async with logged_in_client(app) as client:
        with capture_logs() as captured_logs:
            created = await client.post(
                API_KEYS_PATH, json={"name": "homepage", "scope": "read_write", "expiresAt": expires_at}
            )
            await client.delete(f"{API_KEYS_PATH}/{created.json()['apiKey']['id']}")
    api_key = created.json()["key"]
    [created_event] = events_named(captured_logs, "api_key_created")
    [revoked_event] = events_named(captured_logs, "api_key_revoked")
    for log_event in (created_event, revoked_event):
        assert log_event["user"] == "admin"
        assert log_event["key"] == "homepage"
        assert log_event["scope"] == "read_write"
        assert log_event["expires_at"] == datetime.fromisoformat(expires_at).isoformat()
        assert "ip" in log_event
        assert api_key not in repr(log_event)
    assert re.fullmatch(
        r'\S+ api_key_created user="admin" ip=\S+ key="homepage"',
        render_login_line(None, "info", dict(created_event)),
    )
    assert re.fullmatch(
        r'\S+ api_key_revoked user="admin" ip=\S+ key="homepage"',
        render_login_line(None, "info", dict(revoked_event)),
    )


async def test_openapi_documents_the_routes():
    async with AsyncTestClient(app=endpoints_app()) as client:
        schema = (await client.get("/schema/openapi.json")).json()
    assert set(schema["paths"][API_KEYS_PATH]) == {"get", "post"}
    assert "delete" in schema["paths"][f"{API_KEYS_PATH}/{{key_id}}"]
    assert "CreatedApiKey" in schema["components"]["schemas"]


@pytest.mark.parametrize(
    "content_type",
    ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", None],
    ids=["text-plain", "text-plain-charset", "form-urlencoded", "no-content-type"],
)
async def test_create_without_a_json_media_type_is_415_and_creates_nothing(content_type: str | None):
    app = endpoints_app()
    headers = {} if content_type is None else {"Content-Type": content_type}
    async with logged_in_client(app) as client:
        res = await client.post(API_KEYS_PATH, content=b'{"name": "sneaky"}', headers=headers)
        listed = await client.get(API_KEYS_PATH)
    assert res.status_code == 415
    assert res.json()["status_code"] == 415
    assert listed.json()["keys"] == []


@pytest.mark.parametrize("content_type", ["application/json", "application/json; charset=utf-8", "Application/JSON"])
async def test_create_with_a_json_media_type_works(content_type: str):
    app = endpoints_app()
    async with logged_in_client(app) as client:
        res = await client.post(API_KEYS_PATH, content=b'{"name": "homepage"}', headers={"Content-Type": content_type})
    assert res.status_code == 201


async def test_padded_64_char_name_is_accepted_and_trimmed():
    app = endpoints_app()
    name = "x" * 64
    async with logged_in_client(app) as client:
        res = await client.post(API_KEYS_PATH, json={"name": f"  {name}  "})
    assert res.status_code == 201
    assert res.json()["apiKey"]["name"] == name


SESSION_ONLY_OPERATIONS = [
    (API_KEYS_PATH, "get"),
    (API_KEYS_PATH, "post"),
    (f"{API_KEYS_PATH}/{{key_id}}", "delete"),
    (f"{API_V1_PREFIX}/auth/me", "get"),
    (f"{API_V1_PREFIX}/auth/logout", "post"),
    (f"{API_V1_PREFIX}/auth/oidc/status", "get"),
]


async def openapi_schema() -> dict[str, Any]:
    async with AsyncTestClient(app=endpoints_app()) as client:
        return (await client.get("/schema/openapi.json")).json()


@pytest.mark.parametrize(("path", "method"), SESSION_ONLY_OPERATIONS)
async def test_session_only_operations_advertise_only_the_cookie(path: str, method: str):
    schema = await openapi_schema()
    assert schema["paths"][path][method]["security"] == [{"sessionCookie": []}]


@pytest.mark.parametrize(
    ("path", "method"),
    [("/api/v1/protected", "get"), (f"{API_V1_PREFIX}/auth/login", "post"), (f"{API_V1_PREFIX}/auth/options", "get")],
)
async def test_other_operations_keep_both_schemes(path: str, method: str):
    schema = await openapi_schema()
    operation = schema["paths"][path][method]
    assert operation.get("security", schema["security"]) == [{"sessionCookie": []}, {"apiKey": []}]


@pytest.mark.parametrize(
    ("path", "method", "status_codes"),
    [
        (API_KEYS_PATH, "get", {"403", "503"}),
        (API_KEYS_PATH, "post", {"403", "409", "415", "503"}),
        (f"{API_KEYS_PATH}/{{key_id}}", "delete", {"403", "404", "409", "503"}),
    ],
)
async def test_openapi_documents_the_error_responses(path: str, method: str, status_codes: set[str]):
    schema = await openapi_schema()
    responses = schema["paths"][path][method]["responses"]
    assert status_codes <= set(responses)
    for status_code in status_codes:
        assert responses[status_code]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorEnvelope"
        }
