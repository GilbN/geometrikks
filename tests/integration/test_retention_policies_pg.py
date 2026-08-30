"""Changing a retention setting must update the existing policy, not skip it.

``add_retention_policy(if_not_exists => TRUE)`` only issues a notice when a
policy already exists, so without an explicit update every install keeps
the ``drop_after`` from its first boot forever.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import text

from geometrikks.server.timescale import _add_retention_policies

pytestmark = pytest.mark.anyio

DEFAULTS = {"raw_retention_days": 180, "debug_retention_days": 30, "hourly_retention_days": 60}


async def _drop_after(engine, name: str) -> timedelta:
    """The retention policy's drop_after for a hypertable or a CAGG view name."""
    async with engine.connect() as conn:
        return (await conn.execute(text("""
            SELECT (j.config->>'drop_after')::interval
            FROM timescaledb_information.jobs j
            LEFT JOIN timescaledb_information.continuous_aggregates c
                   ON c.materialization_hypertable_schema = j.hypertable_schema
                  AND c.materialization_hypertable_name = j.hypertable_name
            WHERE j.proc_name = 'policy_retention'
              AND COALESCE(c.view_name, j.hypertable_name) = :name
        """), {"name": name})).scalar_one()


async def test_changed_retention_days_update_the_existing_policies(pg_engine):
    async with pg_engine.begin() as conn:
        await _add_retention_policies(conn, **DEFAULTS)
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
            await _add_retention_policies(conn, **DEFAULTS)

    assert await _drop_after(pg_engine, "access_logs") == timedelta(days=180)
    assert await _drop_after(pg_engine, "summary_hourly_stats") == timedelta(days=60)
