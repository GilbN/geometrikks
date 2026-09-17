"""Session backend: id rotation on login, write-on-change, absolute lifetime.

Stock Litestar reuses the incoming session id and writes the session back on
every response, renewing its expiry. The subclass under test changes both.
"""
from __future__ import annotations

import asyncio
import threading
import time

import anyio
import pytest
from litestar import Request, get
from litestar.testing import AsyncTestClient, TestClient

from geometrikks.server.auth import SESSION_MAX_AGE_SECONDS
from geometrikks.services.oidc.client import PENDING_LIFETIME_SECONDS
from tests.test_auth_endpoints import make_app

pytestmark = pytest.mark.anyio

CREDS = {"username": "admin", "password": "bestpasswordintheworldnojoke"}


@get("/api/v1/seed", exclude_from_auth=True)
async def seed(request: Request) -> dict[str, bool]:
    """Plant a pre-login session, the way the OIDC start endpoint will."""
    request.set_session({"stage": "pre-login"})
    return {"ok": True}


async def test_login_rotates_the_session_id():
    app = make_app(extra_handlers=[seed])
    async with AsyncTestClient(app=app) as client:
        pre = (await client.get("/api/v1/seed")).cookies["session"]
        res = await client.post("/api/v1/auth/login", json=CREDS)
        assert res.status_code == 200
        after = res.cookies["session"]
        assert after != pre
        store = app.stores.get("sessions")
        assert await store.get(pre) is None
        assert await store.get(after) is not None
        client.cookies.set("session", pre)
        assert (await client.get("/api/v1/protected")).status_code == 401


async def test_first_login_without_a_prior_cookie_still_sets_one():
    async with AsyncTestClient(app=make_app()) as client:
        res = await client.post("/api/v1/auth/login", json=CREDS)
        assert res.status_code == 200
        assert res.cookies.get("session")
        assert (await client.get("/api/v1/protected")).status_code == 200


async def test_anonymous_requests_get_no_cookie():
    async with AsyncTestClient(app=make_app()) as client:
        res = await client.get("/api/v1/auth/me")
        assert res.status_code == 401
        assert "set-cookie" not in res.headers


async def test_untouched_session_is_not_rewritten_and_does_not_renew():
    app = make_app(session_max_age=100)
    async with AsyncTestClient(app=app) as client:
        sid = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        store = app.stores.get("sessions")
        await anyio.sleep(1.1)
        res = await client.get("/api/v1/protected")
        assert res.status_code == 200
        assert "set-cookie" not in res.headers
        remaining = await store.expires_in(sid)
        assert remaining is not None and remaining <= 99


async def test_session_expires_absolutely():
    app = make_app(session_max_age=1)
    async with AsyncTestClient(app=app) as client:
        assert (await client.post("/api/v1/auth/login", json=CREDS)).status_code == 200
        assert (await client.get("/api/v1/protected")).status_code == 200
        await anyio.sleep(1.2)
        assert (await client.get("/api/v1/protected")).status_code == 401


def test_logout_is_not_undone_by_an_in_flight_request():
    events: dict[str, asyncio.Event] = {}

    @get("/api/v1/slow")
    async def slow() -> dict[str, bool]:
        events["entered"].set()
        await events["gate"].wait()
        return {"ok": True}

    app = make_app(extra_handlers=[slow])
    with TestClient(app=app) as client, client.portal() as portal:
        # Events must belong to the loop the app runs on, which is the portal's.
        events["entered"], events["gate"] = portal.call(asyncio.Event), portal.call(asyncio.Event)
        sid = client.post("/api/v1/auth/login", json=CREDS).cookies["session"]
        store = app.stores.get("sessions")
        results: list[int] = []
        worker = threading.Thread(
            target=lambda: results.append(client.get("/api/v1/slow").status_code)
        )
        worker.start()
        portal.call(events["entered"].wait)
        assert client.post("/api/v1/auth/logout").status_code in (200, 204)
        portal.call(events["gate"].set)
        worker.join(timeout=5)
        assert results == [200]
        assert portal.call(store.get, sid) is None
        assert client.get("/api/v1/protected").status_code == 401


def test_in_flight_request_cannot_restore_the_pre_rotation_session():
    events: dict[str, asyncio.Event] = {}

    @get("/api/v1/slow-seeded", exclude_from_auth=True)
    async def slow_seeded(request: Request) -> dict[str, bool]:
        events["entered"].set()
        await events["gate"].wait()
        return {"seeded": request.session.get("stage") == "pre-login"}

    app = make_app(extra_handlers=[seed, slow_seeded])
    with TestClient(app=app) as client, client.portal() as portal:
        events["entered"], events["gate"] = portal.call(asyncio.Event), portal.call(asyncio.Event)
        pre = client.get("/api/v1/seed").cookies["session"]
        store = app.stores.get("sessions")
        results: list[int] = []
        worker = threading.Thread(
            target=lambda: results.append(client.get("/api/v1/slow-seeded").status_code)
        )
        worker.start()
        portal.call(events["entered"].wait)
        assert client.post("/api/v1/auth/login", json=CREDS).status_code == 200
        portal.call(events["gate"].set)
        worker.join(timeout=5)
        assert results == [200]
        assert portal.call(store.get, pre) is None
        assert client.get("/api/v1/protected").status_code == 200


def test_pending_session_gets_a_short_lifetime_not_the_configured_one():
    """/oidc/start plants a pending session before anyone is authenticated, so
    every anonymous caller can trigger a write. Giving it the full 7-day
    max_age like a real login would let a loop of anonymous starts grow the
    store without bound; PENDING_LIFETIME_SECONDS is all the PendingLogin it
    holds is ever good for.
    """
    app = make_app(extra_handlers=[seed])
    with TestClient(app=app) as client, client.portal() as portal:
        store = app.stores.get("sessions")

        pending = client.get("/api/v1/seed")
        pending_sid = pending.cookies["session"]
        remaining = portal.call(store.expires_in, pending_sid)
        assert remaining is not None and remaining <= PENDING_LIFETIME_SECONDS
        assert f"Max-Age={PENDING_LIFETIME_SECONDS}" in pending.headers["set-cookie"]

        login = client.post("/api/v1/auth/login", json=CREDS)
        assert login.status_code == 200
        login_sid = login.cookies["session"]
        login_remaining = portal.call(store.expires_in, login_sid)
        assert login_remaining is not None and login_remaining > PENDING_LIFETIME_SECONDS
        assert f"Max-Age={SESSION_MAX_AGE_SECONDS}" in login.headers["set-cookie"]


def test_a_pending_write_sweeps_expired_entries_once_the_throttle_allows_it():
    """MemoryStore only drops an expired row when something reads it; nothing
    else sweeps it on a schedule. The very first pending write is always due
    (the sweep throttle starts at zero), so it must clear out rows that
    expired before anyone came back to read them.
    """
    app = make_app(extra_handlers=[seed])
    with TestClient(app=app) as client, client.portal() as portal:
        store = app.stores.get("sessions")
        portal.call(store.set, "stale-pending", b"{}", 0.01)
        time.sleep(0.05)
        # Not swept yet: exists() doesn't check expiry, only get() and delete_expired() do.
        assert portal.call(store.exists, "stale-pending") is True

        client.get("/api/v1/seed")

        assert portal.call(store.exists, "stale-pending") is False
