"""Channels backend must degrade, not crash, when Postgres is unreachable."""
from __future__ import annotations

import asyncio

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
        self.close_called = False

    def add_termination_listener(self, callback) -> None:
        self._listeners.add(callback)

    def remove_termination_listener(self, callback) -> None:
        self._listeners.discard(callback)

    async def close(self) -> None:
        self.close_called = True
        for cb in list(self._listeners):
            cb(self)
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
