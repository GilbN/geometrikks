"""Location CAGGs with server: shape, correctness, and the pollution gate."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from geometrikks.config.settings import get_settings
from geometrikks.server import timescale
from geometrikks.server.timescale import refresh_caggs_range, setup_timescaledb

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _drop_caggs_with_retry(engine, *caggs: str, attempts: int = 4) -> None:
    """DROP ... CASCADE can race a TimescaleDB background refresh job on the
    same CAGG ("tuple concurrently deleted"). Retry briefly; each attempt gets
    its own transaction because a failure aborts the one it ran in."""
    for cagg in caggs:
        for attempt in range(attempts):
            try:
                async with engine.begin() as conn:
                    await conn.execute(
                        text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE")
                    )
                break
            except DBAPIError:
                if attempt == attempts - 1:
                    raise
                await asyncio.sleep(0.5)


async def _seed_geo_events(session_maker, servers: list[str], per_server: int = 5) -> None:
    """per_server events for each server, 2 days back (CAGG range, not raw-only)."""
    async with session_maker() as session:
        loc = (await session.execute(text(
            "INSERT INTO geo_locations (latitude, longitude, geohash, geographic_point, "
            "country_code, country_name, city, created_at, updated_at) "
            "VALUES (59.9, 10.7, 'u4xsx', ST_SetSRID(ST_MakePoint(10.7, 59.9), 4326), "
            "'NO', 'Norway', 'Oslo', now(), now()) RETURNING id"
        ))).scalar_one()
        for server in servers:
            for i in range(per_server):
                await session.execute(text(
                    "INSERT INTO geo_events (timestamp, ip_address, server, location_id) "
                    "VALUES (:ts, '203.0.113.7', :server, :loc)"
                ), {"ts": NOW - timedelta(days=2, minutes=i), "server": server, "loc": loc})
        await session.commit()


async def test_location_caggs_carry_server_column(pg_engine):
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_name IN ('location_hourly_stats', 'location_daily_stats')"
        ))
        cols = {(r.table_name, r.column_name) for r in rows}
    for view in ("location_hourly_stats", "location_daily_stats"):
        assert (view, "server") in cols


async def test_filtered_cagg_counts_match_raw(pg_engine, pg_session_maker, clean_tables):
    await _seed_geo_events(pg_session_maker, ["nginx-01", "traefik-01"], per_server=5)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=3), end=NOW,
        caggs=["location_hourly_stats"],
    )
    async with pg_engine.connect() as conn:
        filtered = (await conn.execute(text(
            "SELECT COALESCE(SUM(event_count), 0) FROM location_hourly_stats "
            "WHERE server = 'nginx-01'"
        ))).scalar_one()
        unfiltered = (await conn.execute(text(
            "SELECT COALESCE(SUM(event_count), 0) FROM location_hourly_stats"
        ))).scalar_one()
    assert filtered == 5
    assert unfiltered == 10


async def test_upgrade_replaces_old_shape(pg_engine, clean_tables):
    """Drop to the pre-server shape, rerun setup, assert the new shape."""
    await _drop_caggs_with_retry(
        pg_engine, "location_hourly_stats", "location_daily_stats"
    )
    async with pg_engine.begin() as conn:
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
    assert "server" in cols
    assert timescale.location_caggs_have_server() is True


async def test_mixed_shape_upgrade_covers_both_caggs(pg_engine, clean_tables):
    """One CAGG upgraded, the other still pre-server (external drift):
    setup must migrate the laggard rather than declare the pair done and
    hand server-filtered queries a view without the column."""
    await _drop_caggs_with_retry(pg_engine, "location_daily_stats")
    async with pg_engine.begin() as conn:
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
            "WHERE table_name = 'location_daily_stats'"
        ))}
    assert "server" in cols
    assert timescale.location_caggs_have_server() is True


async def test_pollution_gate_keeps_old_shape(pg_engine, pg_session_maker, clean_tables):
    """Container-ID server names present: setup must NOT migrate, and the flag
    plus cached pollution report must say so; consolidating then heals."""
    from geometrikks.server.timescale import CONTAINER_ID_THRESHOLD

    ids = [f"{i:012x}" for i in range(CONTAINER_ID_THRESHOLD)]
    await _seed_geo_events(pg_session_maker, ids, per_server=1)
    await _drop_caggs_with_retry(
        pg_engine, "location_hourly_stats", "location_daily_stats"
    )
    async with pg_engine.begin() as conn:
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
    assert "server" not in cols
    assert timescale.location_caggs_have_server() is False
    pollution = timescale.get_server_name_pollution()
    assert pollution is not None
    assert pollution.polluted is True

    # Consolidate (the remedy) and rerun setup: migration happens.
    async with pg_engine.begin() as conn:
        await conn.execute(text("UPDATE geo_events SET server = 'geometrikks'"))
    await setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'location_hourly_stats'"
        ))}
    assert "server" in cols
    assert timescale.location_caggs_have_server() is True


async def test_repository_server_filter_reads_cagg(pg_engine, pg_session_maker, clean_tables):
    """7-day range + server filter goes through the CAGG and matches raw."""
    from geometrikks.domain.geo.repositories import GeoLocationRepository

    await _seed_geo_events(pg_session_maker, ["nginx-01", "traefik-01"], per_server=5)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=3), end=NOW,
        caggs=["location_hourly_stats"],
    )
    async with pg_session_maker() as session:
        repo = GeoLocationRepository(session=session)
        rows = await repo.get_all_with_event_counts(
            from_timestamp=NOW - timedelta(days=7),
            to_timestamp=NOW + timedelta(hours=1),
            servers=["nginx-01"],
        )
    assert sum(r.event_count for r in rows) == 5
