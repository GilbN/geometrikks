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
