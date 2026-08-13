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


async def test_on_startup_registers_termination_listener() -> None:
    """A dropped LISTEN connection must be logged, not silently swallowed."""

    class FakeConnection:
        def __init__(self) -> None:
            self.termination_callback = None

        def add_termination_listener(self, callback) -> None:
            self.termination_callback = callback

    fake_conn = FakeConnection()

    async def make_connection() -> FakeConnection:
        return fake_conn

    backend = DegradedTolerantAsyncPgBackend(make_connection=make_connection)
    await backend.on_startup()

    assert backend.degraded is False
    assert fake_conn.termination_callback is not None

    # The callback itself must be exception-safe -- calling it must not raise.
    fake_conn.termination_callback(fake_conn)
