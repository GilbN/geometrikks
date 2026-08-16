"""Location CAGGs with hostname: shape, correctness, and the pollution gate."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.config.settings import get_settings
from geometrikks.server import timescale
from geometrikks.server.timescale import refresh_caggs_range, setup_timescaledb

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _seed_geo_events(session_maker, hostnames: list[str], per_host: int = 5) -> None:
    """per_host events for each hostname, 2 days back (CAGG range, not raw-only)."""
    async with session_maker() as session:
        loc = (await session.execute(text(
            "INSERT INTO geo_locations (latitude, longitude, geohash, geographic_point, "
            "country_code, country_name, city, created_at, updated_at) "
            "VALUES (59.9, 10.7, 'u4xsx', ST_SetSRID(ST_MakePoint(10.7, 59.9), 4326), "
            "'NO', 'Norway', 'Oslo', now(), now()) RETURNING id"
        ))).scalar_one()
        for host in hostnames:
            for i in range(per_host):
                await session.execute(text(
                    "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                    "VALUES (:ts, '203.0.113.7', :host, :loc)"
                ), {"ts": NOW - timedelta(days=2, minutes=i), "host": host, "loc": loc})
        await session.commit()


async def test_location_caggs_carry_hostname_column(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_name IN ('location_hourly_stats', 'location_daily_stats')"
        ))
        cols = {(r.table_name, r.column_name) for r in rows}
    for view in ("location_hourly_stats", "location_daily_stats"):
        assert (view, "hostname") in cols


async def test_filtered_cagg_counts_match_raw(pg_engine, pg_session_maker, clean_tables):
    await _seed_geo_events(pg_session_maker, ["nginx-01", "traefik-01"], per_host=5)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=3), end=NOW,
        caggs=["location_hourly_stats"],
    )
    async with pg_engine.connect() as conn:
        filtered = (await conn.execute(text(
            "SELECT COALESCE(SUM(event_count), 0) FROM location_hourly_stats "
            "WHERE hostname = 'nginx-01'"
        ))).scalar_one()
        unfiltered = (await conn.execute(text(
            "SELECT COALESCE(SUM(event_count), 0) FROM location_hourly_stats"
        ))).scalar_one()
    assert filtered == 5
    assert unfiltered == 10


async def test_upgrade_replaces_old_shape(pg_engine, clean_tables):
    """Drop to the pre-hostname shape, rerun setup, assert the new shape."""
    async with pg_engine.begin() as conn:
        for cagg in ("location_hourly_stats", "location_daily_stats"):
            await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
        await conn.execute(text(
            "CREATE MATERIALIZED VIEW location_hourly_stats "
            "WITH (timescaledb.continuous) AS "
            "SELECT time_bucket('1 hour', timestamp) AS bucket, location_id, "
            "COUNT(*) AS event_count FROM geo_events "
            "GROUP BY bucket, location_id WITH NO DATA"
        ))
        await conn.execute(text(
            "CREATE MATERIALIZED VIEW location_daily_stats "
            "WITH (timescaledb.continuous) AS "
            "SELECT time_bucket('1 day', timestamp) AS bucket, location_id, "
            "COUNT(*) AS event_count FROM geo_events "
            "GROUP BY bucket, location_id WITH NO DATA"
        ))
    await setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'location_hourly_stats'"
        ))}
    assert "hostname" in cols
    assert timescale.location_caggs_have_hostname() is True


async def test_pollution_gate_keeps_old_shape(pg_engine, pg_session_maker, clean_tables):
    """Container-ID hostnames present: setup must NOT migrate, and the flag
    plus cached pollution report must say so; consolidating then heals."""
    from geometrikks.server.timescale import CONTAINER_ID_THRESHOLD

    ids = [f"{i:012x}" for i in range(CONTAINER_ID_THRESHOLD)]
    await _seed_geo_events(pg_session_maker, ids, per_host=1)
    async with pg_engine.begin() as conn:
        for cagg in ("location_hourly_stats", "location_daily_stats"):
            await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
        await conn.execute(text(
            "CREATE MATERIALIZED VIEW location_hourly_stats "
            "WITH (timescaledb.continuous) AS "
            "SELECT time_bucket('1 hour', timestamp) AS bucket, location_id, "
            "COUNT(*) AS event_count FROM geo_events "
            "GROUP BY bucket, location_id WITH NO DATA"
        ))
        await conn.execute(text(
            "CREATE MATERIALIZED VIEW location_daily_stats "
            "WITH (timescaledb.continuous) AS "
            "SELECT time_bucket('1 day', timestamp) AS bucket, location_id, "
            "COUNT(*) AS event_count FROM geo_events "
            "GROUP BY bucket, location_id WITH NO DATA"
        ))

    await setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'location_hourly_stats'"
        ))}
    assert "hostname" not in cols
    assert timescale.location_caggs_have_hostname() is False
    pollution = timescale.get_hostname_pollution()
    assert pollution is not None
    assert pollution.polluted is True

    # Consolidate (the remedy) and rerun setup: migration happens.
    async with pg_engine.begin() as conn:
        await conn.execute(text("UPDATE geo_events SET hostname = 'geometrikks'"))
    await setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'location_hourly_stats'"
        ))}
    assert "hostname" in cols
    assert timescale.location_caggs_have_hostname() is True
