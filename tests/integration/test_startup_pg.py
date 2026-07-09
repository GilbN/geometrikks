"""Startup schema path against real TimescaleDB: alembic head + timescale objects."""
from __future__ import annotations

from sqlalchemy import text

EXPECTED_TABLES = {"geo_locations", "geo_events", "access_logs", "access_log_debug"}
EXPECTED_HYPERTABLES = {"geo_events", "access_logs", "access_log_debug"}
EXPECTED_CAGGS = {
    "summary_hourly_stats", "summary_daily_stats",
    "geo_summary_hourly_stats", "geo_summary_daily_stats",
    "location_hourly_stats", "location_daily_stats",
    "ip_location_daily_stats",
}


async def test_alembic_head_created_all_tables(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        ))
        tables = {r.tablename for r in rows}
    assert EXPECTED_TABLES <= tables
    assert "alembic_versions" in tables, "version table must be stamped"


async def test_alembic_version_matches_script_head(pg_engine):
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    head = ScriptDirectory.from_config(cfg).get_current_head()

    async with pg_engine.connect() as conn:
        row = await conn.execute(text("SELECT version_num FROM alembic_versions"))
        assert row.scalar() == head


async def test_hypertables_created(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT hypertable_name FROM timescaledb_information.hypertables"
        ))
        assert EXPECTED_HYPERTABLES <= {r.hypertable_name for r in rows}


async def test_caggs_created(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT view_name FROM timescaledb_information.continuous_aggregates"
        ))
        assert EXPECTED_CAGGS <= {r.view_name for r in rows}


async def test_setup_timescaledb_is_idempotent(pg_engine):
    """Second run on an initialized DB must not raise (startup re-runs it)."""
    from geometrikks.config.settings import get_settings
    from geometrikks.server.timescale import setup_timescaledb

    await setup_timescaledb(pg_engine, get_settings().analytics)
