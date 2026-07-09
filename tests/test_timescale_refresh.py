"""refresh_caggs_range must bind timestamps as query args, never interpolate."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server.timescale import refresh_caggs_range

START = datetime(2026, 1, 1, tzinfo=timezone.utc)
END = datetime(2026, 2, 1, tzinfo=timezone.utc)


def make_engine(recorder: list) -> MagicMock:
    """Engine whose raw asyncpg connection records execute(sql, *args) calls."""
    driver = MagicMock()

    async def record_execute(sql, *args):
        recorder.append((sql, args))

    driver.execute = record_execute

    raw = MagicMock()
    raw.driver_connection = driver

    conn = MagicMock()
    conn.get_raw_connection = AsyncMock(return_value=raw)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=conn)
    return engine


async def test_timestamps_are_bound_not_interpolated():
    calls: list = []
    engine = make_engine(calls)

    await refresh_caggs_range(engine, start=START, end=END, caggs=["summary_hourly_stats"])

    assert len(calls) == 1
    sql, args = calls[0]
    assert "$1" in sql and "$2" in sql, "expected asyncpg positional parameters"
    assert START.isoformat() not in sql, "timestamp interpolated into SQL"
    assert args == (START, END)
    assert "summary_hourly_stats" in sql  # identifier stays in SQL, from allowlist


async def test_unknown_cagg_rejected():
    engine = make_engine([])
    with pytest.raises(ValueError, match="Unknown CAGG"):
        await refresh_caggs_range(engine, start=START, end=END, caggs=["evil; DROP TABLE"])


async def test_defaults_to_all_caggs():
    from geometrikks.server.timescale import ALL_CAGGS
    calls: list = []
    engine = make_engine(calls)
    await refresh_caggs_range(engine, start=START, end=END)
    assert len(calls) == len(ALL_CAGGS)


async def test_scheduler_job_binds_timestamps(monkeypatch):
    from geometrikks.server import scheduler as sched

    calls: list = []

    async def fake_exec(sql, *args):
        calls.append((sql, args))

    monkeypatch.setattr(sched, "_execute_call_outside_transaction", fake_exec)

    await sched.refresh_continuous_aggregate_job(None, "summary_hourly_stats", START, END)
    sql, args = calls[0]
    assert "$1" in sql and args == (START, END)


async def test_scheduler_job_rejects_unknown_cagg(monkeypatch):
    from geometrikks.server import scheduler as sched
    with pytest.raises(ValueError, match="Unknown CAGG"):
        await sched.refresh_continuous_aggregate_job(None, "not_a_cagg")


async def test_cagg_summary_returned_when_only_geo_events_exist():
    """analytics/repositories.py: zero access logs but nonzero geo events
    must still produce a SummaryStats (was: returned None)."""
    from types import SimpleNamespace

    from geometrikks.domain.analytics.repositories import (
        StatsGranularity,
        SummaryStatsRepository,
    )

    row = SimpleNamespace(
        total_log_records=0, total_bytes=0, status_2xx=0, status_3xx=0,
        status_4xx=0, status_5xx=0, avg_request_time=0.0, max_request_time=0.0,
        p50_request_time=0.0, p95_request_time=0.0, p99_request_time=0.0,
        total_geo_records=42, unique_ips=7, unique_countries=3, unique_cities=5,
        malformed_requests=0,
    )
    result = MagicMock()
    result.one_or_none.return_value = row
    session = MagicMock()
    session.execute = AsyncMock(return_value=result)

    repo = SummaryStatsRepository(session=session)
    stats = await repo._get_summary_from_cagg(START, END, StatsGranularity.HOURLY)
    assert stats is not None
    assert stats.total_geo_records == 42
    assert stats.total_log_records == 0
