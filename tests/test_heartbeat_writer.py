"""HeartbeatWriter without a database: failure logging and task lifecycle."""
from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest
import structlog
from litestar import Litestar

from geometrikks.config.settings import AppSettings, Settings
from geometrikks.domain.instances.heartbeat import HeartbeatWriter

pytestmark = pytest.mark.anyio


class _UnreachableEngine:
    def __init__(self) -> None:
        self.begin_calls = 0

    def begin(self) -> Any:
        self.begin_calls += 1
        raise OSError("connection refused")


def _writer(engine: _UnreachableEngine, *, interval: float = 30.0) -> HeartbeatWriter:
    settings = Settings(_env_file=None, app=AppSettings(_env_file=None, mode="agent"))
    return HeartbeatWriter(
        Litestar(route_handlers=[]), settings, cast("Any", engine), interval=interval
    )


async def test_beat_returns_false_and_logs_once_on_repeated_failure() -> None:
    writer = _writer(_UnreachableEngine())

    with structlog.testing.capture_logs() as captured:
        results = [await writer.beat() for _ in range(3)]

    assert results == [False, False, False]
    warnings = [
        log_entry
        for log_entry in captured
        if log_entry["event"] == "heartbeat_write_failed" and log_entry["log_level"] == "warning"
    ]
    assert len(warnings) == 1
    assert "connection refused" in warnings[0]["error"]


async def test_stop_is_idempotent() -> None:
    writer = _writer(_UnreachableEngine())
    writer.start()
    await writer.stop()
    await writer.stop()


async def test_stop_without_start() -> None:
    writer = _writer(_UnreachableEngine())
    await writer.stop()


async def test_start_beats_immediately_and_stop_cancels_the_sleep() -> None:
    engine = _UnreachableEngine()
    writer = _writer(engine, interval=3600.0)
    writer.start()
    async with asyncio.timeout(5):
        while engine.begin_calls == 0:
            await asyncio.sleep(0.01)
    async with asyncio.timeout(1):
        await writer.stop()
    assert engine.begin_calls == 1
