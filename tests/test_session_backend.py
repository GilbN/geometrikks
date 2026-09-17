"""Session backend: id rotation on login, write-on-change, absolute lifetime.

Stock Litestar reuses the incoming session id and writes the session back on
every response, renewing its expiry. The subclass under test changes both.
"""
from __future__ import annotations

import asyncio
import re
import threading
import time

import anyio
import pytest
from litestar import Request, get
from litestar.testing import AsyncTestClient, TestClient

from geometrikks.server.auth import PENDING_SESSION_HEADROOM_SECONDS, SESSION_MAX_AGE_SECONDS
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


@get("/api/v1/touch-session", exclude_from_auth=True)
async def touch_session(request: Request) -> dict[str, bool]:
    """A session-mutating authenticated request, the shape of /oidc/start
    merging oidc_pending into an already-logged-in session."""
    session = dict(request.session or {})
    session["touched"] = True
    request.set_session(session)
    return {"ok": True}


async def test_writing_a_loaded_session_does_not_renew_its_absolute_expiry():
    """A write of a loaded session keeps the store's remaining lifetime.

    Otherwise every /oidc/start from a logged-in caller would extend the
    7-day expiry set at login.
    """
    app = make_app(extra_handlers=[touch_session], session_max_age=100)
    async with AsyncTestClient(app=app) as client:
        sid = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        store = app.stores.get("sessions")
        login_remaining = await store.expires_in(sid)
        # The rotation path (a fresh login) still gets the full max_age.
        assert login_remaining is not None and login_remaining > 95

        await anyio.sleep(2.2)
        res = await client.get("/api/v1/touch-session")
        assert res.status_code == 200
        assert res.cookies["session"] == sid  # no rotation, same store entry

        remaining = await store.expires_in(sid)
        assert remaining is not None and remaining <= 98

        # The cookie must not outlive or undercut the store entry it names.
        match = re.search(r"Max-Age=(\d+)", res.headers["set-cookie"])
        assert match is not None
        assert abs(int(match.group(1)) - remaining) <= 1


async def test_final_second_session_write_clears_rather_than_renews():
    """A session with under a second left is cleared, not revived.

    MemoryStore.expires_in truncates to whole seconds, so 0.4 s left reads
    as 0; treating 0 as "nothing stored" would hand the session a fresh
    7 days under the same id.
    """
    app = make_app(extra_handlers=[touch_session], session_max_age=2)
    async with AsyncTestClient(app=app) as client:
        sid = (await client.post("/api/v1/auth/login", json=CREDS)).cookies["session"]
        store = app.stores.get("sessions")
        for _ in range(100):
            remaining = await store.expires_in(sid)
            if remaining is not None and remaining <= 0:
                break
            await anyio.sleep(0.05)
        else:
            pytest.fail("session never reached its final second")

        res = await client.get("/api/v1/touch-session")
        assert res.status_code == 200
        assert await store.get(sid) is None

        assert (await client.get("/api/v1/protected")).status_code == 401


def test_logout_during_a_parked_session_write_clears_the_session():
    """A session write that finishes after logout must not plant the entry back.

    The real shape is /oidc/start merging oidc_pending into a logged-in
    session while the same browser logs out.
    """
    events: dict[str, asyncio.Event] = {}

    @get("/api/v1/slow-touch", exclude_from_auth=True)
    async def slow_touch(request: Request) -> dict[str, bool]:
        events["entered"].set()
        await events["gate"].wait()
        session = dict(request.session or {})
        session["touched"] = True
        request.set_session(session)
        return {"ok": True}

    app = make_app(extra_handlers=[slow_touch])
    with TestClient(app=app) as client, client.portal() as portal:
        events["entered"], events["gate"] = portal.call(asyncio.Event), portal.call(asyncio.Event)
        sid = client.post("/api/v1/auth/login", json=CREDS).cookies["session"]
        store = app.stores.get("sessions")
        results: list = []
        worker = threading.Thread(
            target=lambda: results.append(client.get("/api/v1/slow-touch"))
        )
        worker.start()
        portal.call(events["entered"].wait)
        assert client.post("/api/v1/auth/logout").status_code in (200, 204)
        portal.call(events["gate"].set)
        worker.join(timeout=5)

        response = results[0]
        assert response.status_code == 200
        assert response.headers["set-cookie"].startswith("session=null")
        assert portal.call(store.get, sid) is None
        assert client.get("/api/v1/protected").status_code == 401


def test_write_lock_blocks_a_racing_logout_until_the_parked_write_finishes(monkeypatch):
    """_store_loaded_session reads store.expires_in and then writes, in two
    awaits. Without one lock across both, a logout's delete can land between
    them and the resumed write puts the session back. A patched expires_in
    forces that interleaving here.

    Litestar builds one session backend per route handler (SessionAuth's
    session_backend is a plain property), so the lock has to live on the
    shared session config; a lock on the backend instance would never see
    the logout handler's delete.
    """
    from litestar.stores.memory import MemoryStore

    events: dict[str, asyncio.Event] = {}
    calls = {"n": 0}
    original_expires_in = MemoryStore.expires_in

    async def patched_expires_in(store_self, session_id):
        calls["n"] += 1
        remaining = await original_expires_in(store_self, session_id)
        if calls["n"] == 1:
            events["paused"].set()
            await events["resume"].wait()
        return remaining

    monkeypatch.setattr(MemoryStore, "expires_in", patched_expires_in)

    app = make_app(extra_handlers=[touch_session])
    with TestClient(app=app) as client, client.portal() as portal:
        events["paused"], events["resume"] = portal.call(asyncio.Event), portal.call(asyncio.Event)
        sid = client.post("/api/v1/auth/login", json=CREDS).cookies["session"]
        store = app.stores.get("sessions")

        touch_results: list = []
        touch_worker = threading.Thread(
            target=lambda: touch_results.append(client.get("/api/v1/touch-session"))
        )
        touch_worker.start()
        portal.call(events["paused"].wait)

        logout_results: list = []
        logout_worker = threading.Thread(
            target=lambda: logout_results.append(client.post("/api/v1/auth/logout"))
        )
        logout_worker.start()
        try:
            logout_worker.join(timeout=0.2)
            still_blocked = logout_worker.is_alive()
        finally:
            # Release the parked write regardless of the outcome above: the
            # touch worker is parked inside the app's event loop, and leaving
            # it there would hang the portal's shutdown instead of failing
            # the assertion cleanly.
            portal.call(events["resume"].set)
        assert still_blocked, "logout must block on the write lock, not run ahead of the parked write"

        touch_worker.join(timeout=5)
        logout_worker.join(timeout=5)

        assert touch_results[0].status_code == 200
        assert logout_results[0].status_code in (200, 204)
        assert portal.call(store.get, sid) is None
        assert client.get("/api/v1/protected").status_code == 401


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
    """/oidc/start writes a pending session for anyone who asks.

    With the 7-day max_age a loop of anonymous starts would grow the store
    without bound; the PendingLogin is only good for PENDING_LIFETIME_SECONDS
    plus the headroom.
    """
    pending_ttl = PENDING_LIFETIME_SECONDS + PENDING_SESSION_HEADROOM_SECONDS
    app = make_app(extra_handlers=[seed])
    with TestClient(app=app) as client, client.portal() as portal:
        store = app.stores.get("sessions")

        pending = client.get("/api/v1/seed")
        pending_sid = pending.cookies["session"]
        remaining = portal.call(store.expires_in, pending_sid)
        assert remaining is not None and remaining <= pending_ttl
        assert f"Max-Age={pending_ttl}" in pending.headers["set-cookie"]

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
