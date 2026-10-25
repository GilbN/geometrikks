"""SessionStore: hashed keys, and a 503 instead of a logout when the store fails."""
from __future__ import annotations

import asyncio
import time
from datetime import timedelta

import pytest
import structlog
from litestar.stores.memory import MemoryStore
from litestar.testing import AsyncTestClient, TestClient
from sqlalchemy.exc import OperationalError

from geometrikks.server.session_store import SessionStore, hash_session_id
from tests.test_auth_endpoints import make_app

CREDS = {"username": "admin", "password": "bestpasswordintheworldnojoke"}


class FailingStore(MemoryStore):
    """A MemoryStore that records every call and raises while ``failing`` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.failing = False
        self.calls: list[tuple[str, str | None]] = []

    def _enter(self, method: str, key: str | None = None) -> None:
        self.calls.append((method, key))
        if self.failing:
            raise OperationalError("stmt", {}, Exception("down"))

    async def set(self, key: str, value: str | bytes, expires_in: int | timedelta | None = None) -> None:
        self._enter("set", key)
        await super().set(key, value, expires_in)

    async def get(self, key: str, renew_for: int | timedelta | None = None) -> bytes | None:
        self._enter("get", key)
        return await super().get(key, renew_for)

    async def delete(self, key: str) -> None:
        self._enter("delete", key)
        await super().delete(key)

    async def delete_all(self) -> None:
        self._enter("delete_all")
        await super().delete_all()

    async def exists(self, key: str) -> bool:
        self._enter("exists", key)
        return await super().exists(key)

    async def expires_in(self, key: str) -> int | None:
        self._enter("expires_in", key)
        return await super().expires_in(key)

    async def delete_expired(self) -> None:
        self._enter("delete_expired")
        await super().delete_expired()


class SlowStore(MemoryStore):
    async def get(self, key: str, renew_for: int | timedelta | None = None) -> bytes | None:
        await asyncio.sleep(10)
        return await super().get(key, renew_for)


def _login(client: TestClient) -> str:
    res = client.post("/api/v1/auth/login", json=CREDS)
    assert res.status_code == 200
    return res.cookies["session"]


def test_store_keeps_the_hash_not_the_cookie_value():
    inner = FailingStore()
    with TestClient(app=make_app(inner_store=inner)) as client:
        cookie = _login(client)
        assert client.blocking_portal.call(inner.get, cookie) is None
        assert client.blocking_portal.call(inner.get, hash_session_id(cookie)) is not None


def test_failed_lookup_answers_503_not_401():
    inner = FailingStore()
    with TestClient(app=make_app(inner_store=inner)) as client:
        _login(client)
        inner.failing = True
        assert client.get("/api/v1/protected").status_code == 503
        assert client.get("/api/v1/auth/me").status_code == 503


def test_no_cookie_still_answers_401_while_the_store_fails():
    inner = FailingStore()
    inner.failing = True
    with TestClient(app=make_app(inner_store=inner)) as client:
        assert client.get("/api/v1/protected").status_code == 401


def test_unavailable_database_answers_503_without_touching_the_store():
    inner = FailingStore()
    app = make_app(inner_store=inner)
    with TestClient(app=app) as client:
        _login(client)
        calls_after_login = len(inner.calls)
        app.state.db_available = False
        assert client.get("/api/v1/protected").status_code == 503
        assert len(inner.calls) == calls_after_login


def test_same_cookie_works_once_the_database_is_back():
    app = make_app(inner_store=FailingStore())
    with TestClient(app=app) as client:
        _login(client)
        app.state.db_available = False
        assert client.get("/api/v1/protected").status_code == 503
        app.state.db_available = True
        assert client.get("/api/v1/protected").status_code == 200


@pytest.mark.anyio
async def test_lookup_gives_up_within_the_timeout():
    app = make_app(inner_store=SlowStore())
    store = app.stores.get("sessions")
    assert isinstance(store, SessionStore)
    store.timeout = 0.2
    async with AsyncTestClient(app=app) as client:
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        started = time.monotonic()
        responses = await asyncio.gather(*(client.get("/api/v1/protected") for _ in range(3)))
        elapsed = time.monotonic() - started
    assert [res.status_code for res in responses] == [503, 503, 503]
    assert elapsed < 2


def test_garbage_cookie_answers_401():
    inner = FailingStore()
    with TestClient(app=make_app(inner_store=inner)) as client:
        client.cookies.set("session", "x" * 5000)
        assert client.get("/api/v1/protected").status_code == 401
    assert ("get", hash_session_id("x" * 5000)) in inner.calls
    assert all(key is None or len(key) == 64 for _, key in inner.calls)


def test_failed_lookup_logs_one_warning_line(tmp_path):
    from geometrikks.config.settings import LogSettings, Settings
    from geometrikks.server.logging import create_logging_config

    log_settings = LogSettings(_env_file=None, dir=tmp_path / "logs")
    logging_config = create_logging_config(Settings(_env_file=None, log=log_settings))
    inner = FailingStore()
    app = make_app(inner_store=inner, logging_config=logging_config)
    with TestClient(app=app) as client:
        _login(client)
        inner.failing = True
        with structlog.testing.capture_logs() as captured:
            assert client.get("/api/v1/protected").status_code == 503
    events = [entry["event"] for entry in captured]
    assert events.count("service_unavailable") == 1
    assert "Uncaught exception" not in events
