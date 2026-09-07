"""Changing a policy setting must update the existing policy, not skip it.

Every ``add_*_policy(if_not_exists => TRUE)`` only issues a notice when a
policy already exists, so without an explicit update every install keeps
the values from its first boot forever.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import text

from geometrikks.server import timescale
from geometrikks.server.timescale import (
    _add_compression_policies,
    _add_refresh_policies,
    _add_retention_policies,
)

pytestmark = pytest.mark.anyio

RETENTION_DEFAULTS = {"raw_retention_days": 180, "debug_retention_days": 30, "hourly_retention_days": 60}

_JOB_FOR_TARGET = """
    FROM timescaledb_information.jobs j
    LEFT JOIN timescaledb_information.continuous_aggregates c
           ON c.materialization_hypertable_schema = j.hypertable_schema
          AND c.materialization_hypertable_name = j.hypertable_name
    WHERE j.proc_name = :proc AND COALESCE(c.view_name, j.hypertable_name) = :name
"""


async def _config_interval(engine, proc: str, name: str, key: str) -> timedelta:
    async with engine.connect() as conn:
        return (await conn.execute(
            text(f"SELECT (j.config->>'{key}')::interval {_JOB_FOR_TARGET}"),
            {"proc": proc, "name": name},
        )).scalar_one()


async def _schedule_interval(engine, name: str) -> timedelta:
    async with engine.connect() as conn:
        return (await conn.execute(
            text(f"SELECT j.schedule_interval {_JOB_FOR_TARGET}"),
            {"proc": "policy_refresh_continuous_aggregate", "name": name},
        )).scalar_one()


async def _drop_after(engine, name: str) -> timedelta:
    return await _config_interval(engine, "policy_retention", name, "drop_after")


async def _compress_after(engine, name: str) -> timedelta:
    return await _config_interval(engine, "policy_compression", name, "compress_after")


async def test_changed_retention_days_update_the_existing_policies(pg_engine):
    async with pg_engine.begin() as conn:
        await _add_retention_policies(conn, **RETENTION_DEFAULTS)
    assert await _drop_after(pg_engine, "access_logs") == timedelta(days=180)

    try:
        async with pg_engine.begin() as conn:
            await _add_retention_policies(
                conn, raw_retention_days=90, debug_retention_days=10, hourly_retention_days=45
            )
        assert await _drop_after(pg_engine, "access_logs") == timedelta(days=90)
        assert await _drop_after(pg_engine, "geo_events") == timedelta(days=90)
        assert await _drop_after(pg_engine, "access_log_debug") == timedelta(days=10)
        assert await _drop_after(pg_engine, "summary_hourly_stats") == timedelta(days=45)
        assert await _drop_after(pg_engine, "asn_hourly_stats") == timedelta(days=45)
    finally:
        async with pg_engine.begin() as conn:
            await _add_retention_policies(conn, **RETENTION_DEFAULTS)

    assert await _drop_after(pg_engine, "access_logs") == timedelta(days=180)
    assert await _drop_after(pg_engine, "summary_hourly_stats") == timedelta(days=60)


async def test_failed_policy_update_rolls_back_only_its_target(
    pg_engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with pg_engine.begin() as conn:
        await _add_retention_policies(conn, **RETENTION_DEFAULTS)

    original_sync = timescale._sync_policy_config

    async def fail_access_logs_after_update(conn, **kwargs):
        result = await original_sync(conn, **kwargs)
        if kwargs["target"] == "access_logs":
            await conn.execute(text("SELECT 1 / 0"))
        return result

    timescale._reset_policy_failures()
    monkeypatch.setattr(timescale, "_sync_policy_config", fail_access_logs_after_update)
    try:
        async with pg_engine.begin() as conn:
            await _add_retention_policies(
                conn,
                raw_retention_days=90,
                debug_retention_days=10,
                hourly_retention_days=45,
            )

        assert await _drop_after(pg_engine, "geo_events") == timedelta(days=90)
        assert await _drop_after(pg_engine, "access_logs") == timedelta(days=180)
        assert await _drop_after(pg_engine, "access_log_debug") == timedelta(days=10)
        [failure] = timescale.get_policy_failures()
        assert (failure.policy, failure.target) == ("retention", "access_logs")
        assert "division by zero" in failure.error
    finally:
        monkeypatch.setattr(timescale, "_sync_policy_config", original_sync)
        async with pg_engine.begin() as conn:
            await _add_retention_policies(conn, **RETENTION_DEFAULTS)
        timescale._reset_policy_failures()


async def test_changed_refresh_interval_updates_the_existing_policies(pg_engine):
    async with pg_engine.begin() as conn:
        await _add_refresh_policies(conn, 5)
    assert await _schedule_interval(pg_engine, "summary_hourly_stats") == timedelta(minutes=5)

    try:
        async with pg_engine.begin() as conn:
            await _add_refresh_policies(conn, 30)
        assert await _schedule_interval(pg_engine, "summary_hourly_stats") == timedelta(minutes=30)
        assert await _schedule_interval(pg_engine, "summary_daily_stats") == timedelta(minutes=30)
        assert await _schedule_interval(pg_engine, "log_source_daily_stats") == timedelta(minutes=30)
    finally:
        async with pg_engine.begin() as conn:
            await _add_refresh_policies(conn, 5)

    assert await _schedule_interval(pg_engine, "summary_hourly_stats") == timedelta(minutes=5)


async def test_changed_compression_days_update_the_existing_policies(pg_engine):
    async with pg_engine.begin() as conn:
        await _add_compression_policies(conn, 7)
    assert await _compress_after(pg_engine, "access_logs") == timedelta(days=7)

    try:
        async with pg_engine.begin() as conn:
            await _add_compression_policies(conn, 3)
        assert await _compress_after(pg_engine, "access_logs") == timedelta(days=3)
        assert await _compress_after(pg_engine, "geo_events") == timedelta(days=3)
        assert await _compress_after(pg_engine, "access_log_debug") == timedelta(days=3)
    finally:
        async with pg_engine.begin() as conn:
            await _add_compression_policies(conn, 7)

    assert await _compress_after(pg_engine, "access_logs") == timedelta(days=7)
