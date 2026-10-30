"""HeartbeatWriter without a database: failure logging and task lifecycle."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any, cast

import pytest
import structlog
from litestar import Litestar

from geometrikks.config.settings import AppSettings, Settings
from geometrikks.domain.instances.heartbeat import STARTUP_GRACE_SECONDS, HeartbeatWriter, WindowCounts

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def disable_heartbeat_writer():
    """Overrides the conftest fixture of the same name so start() stays real here."""
    yield


class _UnreachableEngine:
    def __init__(self) -> None:
        self.begin_calls = 0

    def begin(self) -> Any:
        self.begin_calls += 1
        raise OSError("connection refused")


def _writer(
    engine: _UnreachableEngine, *, interval: float = 30.0, clock: Callable[[], float] = time.monotonic
) -> HeartbeatWriter:
    settings = Settings(_env_file=None, app=AppSettings(_env_file=None, mode="agent"))
    return HeartbeatWriter(
        Litestar(route_handlers=[]), settings, cast("Any", engine), interval=interval, _clock=clock
    )


def _stopped_events(captured: list[Any]) -> list[Any]:
    return [log_entry for log_entry in captured if log_entry["event"] == "heartbeat_writer_stopped"]


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
    with structlog.testing.capture_logs() as captured:
        await writer.stop()
        await writer.stop()
    assert len(_stopped_events(captured)) == 1


async def test_stop_without_start() -> None:
    writer = _writer(_UnreachableEngine())
    with structlog.testing.capture_logs() as captured:
        await writer.stop()
    assert _stopped_events(captured) == []


async def test_failures_during_startup_grace_log_at_debug() -> None:
    clock_reading = [1000.0]
    writer = _writer(_UnreachableEngine(), interval=3600.0, clock=lambda: clock_reading[0])
    writer.start()
    # Cancelled before the task's first step, so only the beats below run.
    await writer.stop()

    with structlog.testing.capture_logs() as captured:
        for seconds_since_start in (10.0, STARTUP_GRACE_SECONDS - 1, STARTUP_GRACE_SECONDS, 150.0):
            clock_reading[0] = 1000.0 + seconds_since_start
            assert await writer.beat() is False

    failure_levels = [
        log_entry["log_level"]
        for log_entry in captured
        if log_entry["event"] == "heartbeat_write_failed"
    ]
    assert failure_levels == ["debug", "debug", "warning", "debug"]


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



def _service_totals(
    *, parsed_lines: int, failed_records: int, written_records: int, failed_batches: int
) -> SimpleNamespace:
    return SimpleNamespace(
        parsed_lines=parsed_lines,
        failed_records=failed_records,
        written_records=written_records,
        failed_batches=failed_batches,
    )


def test_counters_report_lines_failures_and_writes_over_five_minutes() -> None:
    writer = _writer(_UnreachableEngine())
    ingestion_service = _service_totals(parsed_lines=100, failed_records=4, written_records=90, failed_batches=1)
    writer._app.state.ingestion_service = ingestion_service

    assert writer._sample_counters(1000.0) == WindowCounts()
    ingestion_service.parsed_lines = 400
    ingestion_service.failed_records = 34
    ingestion_service.written_records = 360
    ingestion_service.failed_batches = 4
    assert writer._sample_counters(1300.0) == WindowCounts(
        lines=300, failed_records=30, written_records=270, failed_batches=3
    )


def test_a_rebuilt_ingestion_service_restarts_every_counter() -> None:
    writer = _writer(_UnreachableEngine())
    writer._app.state.ingestion_service = _service_totals(
        parsed_lines=100, failed_records=0, written_records=90, failed_batches=0
    )
    writer._sample_counters(1000.0)
    writer._app.state.ingestion_service = _service_totals(
        parsed_lines=120, failed_records=5, written_records=0, failed_batches=1
    )

    assert writer._sample_counters(1300.0) == WindowCounts()


def test_one_counter_going_back_restarts_every_counter() -> None:
    writer = _writer(_UnreachableEngine())
    ingestion_service = _service_totals(parsed_lines=100, failed_records=0, written_records=90, failed_batches=0)
    writer._app.state.ingestion_service = ingestion_service
    writer._sample_counters(1000.0)
    ingestion_service.written_records = 10
    ingestion_service.failed_records = 5

    assert writer._sample_counters(1300.0) == WindowCounts()
