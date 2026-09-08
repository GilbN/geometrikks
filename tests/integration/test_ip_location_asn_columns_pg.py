"""Per-IP CAGGs gain the ASN columns in place; old-shape views upgrade without a drop."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from structlog.testing import capture_logs

from geometrikks.config.settings import get_settings
from geometrikks.server import timescale
from geometrikks.server.timescale import refresh_caggs_range, setup_timescaledb
from tests.integration.test_geo_logs_pg import _insert_location

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
RETENTION_DAYS = get_settings().analytics.raw_retention_days

OLD_SHAPE = {
    "ip_location_hourly_stats": """
        CREATE MATERIALIZED VIEW ip_location_hourly_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 hour', timestamp) AS bucket,
            location_id,
            ip_address,
            COUNT(*) AS event_count
        FROM geo_events
        GROUP BY bucket, location_id, ip_address
        WITH NO DATA
    """,
    "ip_location_daily_stats": """
        CREATE MATERIALIZED VIEW ip_location_daily_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('1 day', timestamp) AS bucket,
            location_id,
            ip_address,
            COUNT(*) AS event_count
        FROM geo_events
        GROUP BY bucket, location_id, ip_address
        WITH NO DATA
    """,
}


async def _drop_view(conn, view: str, *, attempts: int = 3) -> None:
    """Retry "tuple concurrently deleted": a policy job may still hold the view."""
    for attempt in range(attempts):
        try:
            async with conn.begin_nested():
                await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE"))
            return
        except Exception:
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(0.5 * (attempt + 1))


async def _seed(session_maker) -> int:
    """One location; 1.1.1.1 has three ASN-stamped events, 2.2.2.2 two without."""
    ts = NOW - timedelta(hours=3)
    async with session_maker() as session:
        loc = await _insert_location(
            session, geohash="asn01", latitude=59.91, longitude=10.75,
            country_code="NO", country_name="Norway", city="Oslo",
        )
        for _ in range(3):
            await session.execute(text(
                "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id, "
                " autonomous_system_number, autonomous_system_organization) "
                "VALUES (:ts, '1.1.1.1', 'web1', :loc, 1221, 'Telstra Pty Ltd')"
            ), {"ts": ts, "loc": loc})
        for _ in range(2):
            await session.execute(text(
                "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                "VALUES (:ts, '2.2.2.2', 'web1', :loc)"
            ), {"ts": ts, "loc": loc})
        await session.commit()
    return loc


async def test_fresh_views_carry_the_asn_columns(pg_engine) -> None:
    await setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        for view in timescale.IP_LOCATION_CAGGS_NAMES:
            cols = set((await conn.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = :v"
            ), {"v": view})).scalars().all())
            assert {"asn", "as_org", "asn_hits"} <= cols, view


@pytest.mark.parametrize("view", list(OLD_SHAPE))
async def test_old_shape_view_upgrades_in_place(pg_engine, pg_session_maker, clean_tables, view) -> None:
    """The gate: setup must take the in-place ALTER path (cagg_column_added
    logged, never cagg_views_recreated), and the forced refresh must fill
    asn/asn_hits for buckets inside retention."""
    loc = await _seed(pg_session_maker)
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
        await conn.execute(text(OLD_SHAPE[view]))
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=2), end=NOW + timedelta(hours=1), caggs=[view],
    )
    async with pg_engine.begin() as conn:
        needs = await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=RETENTION_DAYS)
    assert view in needs

    with capture_logs() as logs:
        await setup_timescaledb(pg_engine, get_settings().analytics)

    events = [(entry["event"], entry.get("view"), entry.get("views")) for entry in logs]
    assert ("cagg_views_recreated", None, [view]) not in events, "in-place ALTER was rejected; setup fell back to drop and recreate"
    assert ("cagg_column_added", view, None) in events

    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            f"SELECT host(ip_address) AS ip, event_count, asn, as_org, asn_hits "
            f"FROM {view} WHERE location_id = :loc ORDER BY ip"
        ), {"loc": loc})).all()
        needs_after = await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=RETENTION_DAYS)

    assert [(r.ip, r.event_count, r.asn, r.as_org, r.asn_hits) for r in rows] == [
        ("1.1.1.1", 3, 1221, "Telstra Pty Ltd", 3),
        ("2.2.2.2", 2, None, None, 0),
    ]
    assert view not in needs_after

    # A refreshed window pushes the watermark past now and would hide later
    # tests' rows from the real-time union; recreate the view empty.
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
    await setup_timescaledb(pg_engine, get_settings().analytics)
