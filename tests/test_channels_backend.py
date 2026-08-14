"""Channels backend must degrade, not crash, when Postgres is unreachable."""
from __future__ import annotations

import asyncio
import contextlib

import pytest

from geometrikks.server.plugins import DegradedTolerantAsyncPgBackend

pytestmark = pytest.mark.anyio


async def test_startup_failure_degrades_instead_of_raising() -> None:
    backend = DegradedTolerantAsyncPgBackend(
        dsn="postgresql://nobody:wrong@127.0.0.1:1/void"
    )
    await backend.on_startup()  # must not raise
    assert backend.degraded is True


async def test_degraded_backend_is_inert() -> None:
    backend = DegradedTolerantAsyncPgBackend(
        dsn="postgresql://nobody:wrong@127.0.0.1:1/void"
    )
    await backend.on_startup()
    await backend.publish(b"{}", ["live_events"])  # no-op, must not raise
    await backend.subscribe(["live_events"])
    await backend.unsubscribe(["live_events"])

    async def first_event():
        async for _ in backend.stream_events():
            return True
        return False

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(first_event(), timeout=0.2)
    await backend.on_shutdown()  # no-op, must not raise


async def test_publish_survives_transient_failure_when_not_degraded() -> None:
    """A non-degraded backend must swallow a publish-time DB failure.

    The parent AsyncPgChannelsBackend.publish() only needs self._queue set
    (not full on_startup) to reach self._connect() -- see the RuntimeError
    guard at the top of the parent method. Seeding just that attribute lets
    us force the failure through the make_connection factory without going
    through on_startup (which would itself call _connect() and flip
    `degraded`, defeating the point of this test).
    """

    async def failing_connect() -> None:
        raise OSError("connection refused")

    backend = DegradedTolerantAsyncPgBackend(make_connection=failing_connect)
    backend._queue = asyncio.Queue()

    await backend.publish(b"{}", ["live_events"])  # must not raise

    assert backend.degraded is False


class FakeConnection:
    """Mirrors the asyncpg.Connection termination-listener behavior we rely
    on: add/remove use set semantics (remove of an absent callback is a
    no-op), and close() fires whatever listeners are still registered --
    asyncpg's real Connection.close() unconditionally calls _cleanup(), which
    calls _call_termination_listeners(), even on a graceful close."""

    def __init__(self) -> None:
        self._listeners: set = set()
        self._listened_channels: set = set()
        self.close_called = False

    def add_termination_listener(self, callback) -> None:
        self._listeners.add(callback)

    def remove_termination_listener(self, callback) -> None:
        self._listeners.discard(callback)

    async def add_listener(self, channel, callback) -> None:
        self._listened_channels.add(channel)

    async def remove_listener(self, channel, callback) -> None:
        self._listened_channels.discard(channel)

    def _call_termination_listeners(self) -> None:
        """Fire registered termination listeners without closing -- mirrors
        asyncpg calling them from _cleanup() on an unexpected connection
        drop (no explicit close() involved)."""
        for cb in list(self._listeners):
            cb(self)

    async def close(self) -> None:
        self.close_called = True
        self._call_termination_listeners()
        self._listeners.clear()


async def test_on_startup_registers_termination_listener() -> None:
    """A dropped LISTEN connection must be logged, not silently swallowed."""
    fake_conn = FakeConnection()

    async def make_connection() -> FakeConnection:
        return fake_conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()

    assert backend.degraded is False
    assert backend._on_listener_terminated in fake_conn._listeners

    # The callback itself must be exception-safe -- calling it must not raise.
    backend._on_listener_terminated(fake_conn)


async def test_unexpected_termination_still_logs_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A connection lost while still registered (i.e. before on_shutdown had
    a chance to unregister it) must still surface as an error."""
    fake_conn = FakeConnection()

    async def make_connection() -> FakeConnection:
        return fake_conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()

    with caplog.at_level("ERROR"):
        await fake_conn.close()  # simulates asyncpg firing listeners on drop

    assert any("listener connection lost" in r.getMessage() for r in caplog.records)


async def test_graceful_shutdown_does_not_log_false_listener_lost(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """asyncpg fires termination listeners on a graceful close() too, so
    on_shutdown must unregister the listener first -- otherwise every normal
    app shutdown/redeploy logs a false "listener connection lost" alarm."""
    fake_conn = FakeConnection()

    async def make_connection() -> FakeConnection:
        return fake_conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()
    assert backend._on_listener_terminated in fake_conn._listeners

    with caplog.at_level("ERROR"):
        await backend.on_shutdown()

    assert fake_conn.close_called is True
    assert not fake_conn._listeners  # unregistered before close fired anything
    assert not any("listener connection lost" in r.getMessage() for r in caplog.records)


async def test_on_shutdown_closes_publish_connection() -> None:
    """on_shutdown must close the persistent publish connection introduced
    alongside the reused-connection publish() path, not just the listener
    connection."""

    class FakePubConn:
        def __init__(self) -> None:
            self.closed = False

        async def execute(self, *a):
            pass

        async def close(self) -> None:
            self.closed = True

        def is_closed(self) -> bool:
            return self.closed

    listener_conn = FakeConnection()
    pub_conn = FakePubConn()
    connections = [listener_conn, pub_conn]

    async def make_connection():
        return connections.pop(0)

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()
    await backend.publish(b"{}", ["live_events"])  # populates self._pub_conn
    assert backend._pub_conn is pub_conn

    await backend.on_shutdown()

    assert pub_conn.closed is True
    assert backend._pub_conn is None


async def test_publish_reuses_one_connection() -> None:
    calls = []

    class FakeConn:
        def __init__(self):
            self.executed = []

        async def execute(self, *a):
            self.executed.append(a)

        async def close(self):
            pass

        def is_closed(self):
            return False

    async def factory():
        conn = FakeConn()
        calls.append(conn)
        return conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=factory)
    await backend.publish(b"{}", ["live_events"])
    await backend.publish(b"{}", ["live_events"])
    assert len(calls) == 1
    assert len(calls[0].executed) == 2


async def test_unexpected_termination_schedules_reconnect(monkeypatch) -> None:
    """On unexpected loss, a reconnect task must spin up and restore the
    exact LISTEN state (connection + subscribed channels + termination
    callback) the parent's on_startup/subscribe would have set up."""
    fake_conn = FakeConnection()
    new_conn = FakeConnection()
    connections = [fake_conn, new_conn]

    async def make_connection() -> FakeConnection:
        return connections.pop(0)

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()
    await backend.subscribe(["live_events"])
    assert backend._subscribed_channels == {"live_events"}

    # Simulate asyncpg firing termination listeners on an unexpected drop.
    fake_conn._call_termination_listeners()
    assert backend._reconnect_task is not None

    await backend._reconnect_task

    assert backend._listener_conn is new_conn
    assert backend._on_listener_terminated in new_conn._listeners
    assert new_conn._listened_channels == {"live_events"}


async def test_reconnect_backs_off_and_stops_on_shutdown(monkeypatch) -> None:
    """The connect factory always fails; backoff must grow 1, 2, 4... capped
    at 30s, and on_shutdown must cancel the reconnect loop so no further
    attempts happen."""
    fake_conn = FakeConnection()
    call_count = 0

    async def make_connection() -> FakeConnection:
        # First call is on_startup's initial connect (must succeed so a
        # listener connection -- and thus a termination listener -- exists
        # to fire from); every call after that is a reconnect attempt, which
        # must fail to exercise backoff.
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return fake_conn
        raise OSError("connection refused")

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()

    delays: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        delays.append(seconds)
        if len(delays) >= 5:
            # Stop the infinite retry loop once we have enough samples;
            # on_shutdown below is what a real caller would do to stop it.
            raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    fake_conn._call_termination_listeners()
    assert backend._reconnect_task is not None

    with contextlib.suppress(asyncio.CancelledError):
        await backend._reconnect_task

    assert delays[:4] == [1, 2, 4, 8]
    assert all(d <= 30 for d in delays)

    await backend.on_shutdown()
    assert backend._reconnect_task is None or backend._reconnect_task.cancelled()


async def test_reconnect_closes_connection_on_partial_setup_failure(monkeypatch) -> None:
    """If _connect() succeeds but a subsequent setup step (add_listener)
    raises, the abandoned connection must be closed before the next
    attempt -- otherwise a flapping DB leaks one socket per failed attempt."""
    fake_conn = FakeConnection()

    class BadListenerConn(FakeConnection):
        async def add_listener(self, channel, callback) -> None:
            raise OSError("listen failed")

    bad_conn = BadListenerConn()
    connections = [fake_conn, bad_conn]

    async def make_connection() -> FakeConnection:
        return connections.pop(0)

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()
    await backend.subscribe(["live_events"])

    async def fake_sleep(seconds: float) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    fake_conn._call_termination_listeners()
    assert backend._reconnect_task is not None

    with contextlib.suppress(asyncio.CancelledError):
        await backend._reconnect_task

    assert bad_conn.close_called is True


async def test_graceful_shutdown_does_not_reconnect() -> None:
    """Existing graceful-shutdown behavior extended: on_shutdown()'s
    unregister-before-close means the termination listener never fires as
    "unexpected", so no reconnect task is ever created."""
    fake_conn = FakeConnection()

    async def make_connection() -> FakeConnection:
        return fake_conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()

    await backend.on_shutdown()

    assert backend._reconnect_task is None


async def test_publish_failure_drops_event_and_reconnects_next_time() -> None:
    calls = []

    class FlakyConn:
        def __init__(self, fail: bool):
            self.fail = fail
            self.executed = []

        async def execute(self, *a):
            if self.fail:
                raise OSError("connection lost")
            self.executed.append(a)

        async def close(self):
            pass

        def is_closed(self):
            return False

    async def factory():
        conn = FlakyConn(fail=len(calls) == 0)
        calls.append(conn)
        return conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=factory)
    await backend.publish(b"{}", ["live_events"])  # fails internally, must not raise
    await backend.publish(b"{}", ["live_events"])  # new connection, succeeds
    assert len(calls) == 2
    assert len(calls[1].executed) == 1
