"""site_homes: migration shape, upsert precedence, override reconcile."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.services.geoip.home import HomeLocation
from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError
from geometrikks.services.geoip.site_homes import (
    delete_site_home,
    fetch_last_event_days,
    fetch_site_homes,
    reconcile_override_homes,
    upsert_auto_homes,
)

pytestmark = pytest.mark.anyio

HOME = HomeLocation(latitude=59.91, longitude=10.75, source="external_ip")


async def test_site_homes_table_exists_with_expected_columns(pg_engine):
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'site_homes'"
        ))}
    assert {"hostname", "latitude", "longitude", "source", "detected_at"} <= cols


async def _rows(pg_session_maker) -> dict[str, tuple[float, float, str]]:
    async with pg_session_maker() as session:
        return {
            h.hostname: (h.latitude, h.longitude, h.source)
            for h in await fetch_site_homes(session)
        }


async def test_auto_upsert_inserts_and_updates(pg_session_maker, clean_site_homes):
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], HOME)
    assert (await _rows(pg_session_maker))["nginx-01"] == (59.91, 10.75, "auto")
    moved = HomeLocation(latitude=60.39, longitude=5.32, source="external_ip")
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], moved)
    assert (await _rows(pg_session_maker))["nginx-01"] == (60.39, 5.32, "auto")


async def test_auto_upsert_skips_none_home(pg_session_maker, clean_site_homes):
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], None)
    assert await _rows(pg_session_maker) == {}


async def test_auto_upsert_never_clobbers_override(pg_session_maker, clean_site_homes):
    await reconcile_override_homes(pg_session_maker, {"nginx-01": (1.0, 2.0)})
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], HOME)
    assert (await _rows(pg_session_maker))["nginx-01"] == (1.0, 2.0, "override")


async def test_reconcile_adds_updates_and_deletes(pg_session_maker, clean_site_homes):
    await reconcile_override_homes(pg_session_maker, {"a": (1.0, 2.0), "b": (3.0, 4.0)})
    await reconcile_override_homes(pg_session_maker, {"a": (5.0, 6.0)})
    rows = await _rows(pg_session_maker)
    assert rows == {"a": (5.0, 6.0, "override")}


async def test_reconcile_leaves_auto_rows_alone(pg_session_maker, clean_site_homes):
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], HOME)
    await reconcile_override_homes(pg_session_maker, {})
    assert "nginx-01" in await _rows(pg_session_maker)


async def test_reconcile_empty_deletes_preexisting_override(pg_session_maker, clean_site_homes):
    await reconcile_override_homes(pg_session_maker, {"a": (1.0, 2.0)})
    await upsert_auto_homes(pg_session_maker, ["nginx-01"], HOME)
    await reconcile_override_homes(pg_session_maker, {})
    rows = await _rows(pg_session_maker)
    assert "a" not in rows
    assert rows["nginx-01"] == (59.91, 10.75, "auto")


async def test_site_homes_source_is_db_constrained(pg_session_maker, clean_site_homes):
    """The auto/override Literal on the wire is backed by a CHECK constraint,
    not just writer convention."""
    from sqlalchemy.exc import IntegrityError

    async with pg_session_maker() as session:
        with pytest.raises(IntegrityError):
            await session.execute(text(
                "INSERT INTO site_homes "
                "(hostname, latitude, longitude, source, created_at, updated_at) "
                "VALUES ('x', 1.0, 2.0, 'bogus', now(), now())"
            ))


async def test_delete_removes_auto_row_and_next_upsert_recreates_it(pg_session_maker, clean_site_homes):
    await upsert_auto_homes(pg_session_maker, ["retired-01"], HOME)
    async with pg_session_maker() as session:
        await delete_site_home(session, "retired-01")
    assert "retired-01" not in await _rows(pg_session_maker)
    # A source that still ingests gets its row back on its next refresh.
    await upsert_auto_homes(pg_session_maker, ["retired-01"], HOME)
    assert (await _rows(pg_session_maker))["retired-01"][2] == "auto"


async def test_delete_refuses_override_and_missing_rows(pg_session_maker, clean_site_homes):
    await reconcile_override_homes(pg_session_maker, {"pinned-01": (51.5, -0.12)})
    async with pg_session_maker() as session:
        with pytest.raises(DomainConflictError):
            await delete_site_home(session, "pinned-01")
        with pytest.raises(DomainNotFoundError):
            await delete_site_home(session, "never-seen")
    assert (await _rows(pg_session_maker))["pinned-01"][2] == "override"


async def test_last_event_days_reports_the_latest_day_per_hostname(
    pg_engine, pg_session_maker, clean_tables, clean_site_homes
):
    """Reads the daily hostname aggregate. Real-time aggregation only covers
    buckets past the materialization watermark, and earlier tests may have
    refreshed the aggregate beyond the seed day, so refresh the seed window
    explicitly instead of relying on it."""
    day = datetime(2026, 8, 20, 13, 0, tzinfo=timezone.utc)
    async with pg_session_maker() as session:
        location_id = (await session.execute(text(
            "INSERT INTO geo_locations (geohash, latitude, longitude, geographic_point, "
            " country_code, country_name, city, last_hit, created_at, updated_at) "
            "VALUES ('sh-last-day', 59.91, 10.75, "
            " ST_SetSRID(ST_MakePoint(10.75, 59.91), 4326)::geography, "
            " 'NO', 'Norway', 'Oslo', now(), now(), now()) RETURNING id"
        ))).scalar_one()
        for ts in (day - timedelta(days=3), day):
            await session.execute(text(
                "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                "VALUES (:ts, '203.0.113.7', 'seen-01', :location_id)"
            ), {"ts": ts, "location_id": location_id})
        await session.commit()
    # CALL cannot run inside a transaction: use the raw asyncpg connection.
    async with pg_engine.connect() as conn:
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(
            "CALL refresh_continuous_aggregate('hostname_daily_stats', $1::timestamptz, $2::timestamptz)",
            day - timedelta(days=4),
            day + timedelta(days=1),
        )
    async with pg_session_maker() as session:
        last = await fetch_last_event_days(session)
    assert last["seen-01"].date() == day.date()
    assert "never-seen" not in last
