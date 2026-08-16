"""site_homes: migration shape, upsert precedence, override reconcile."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from geometrikks.services.geoip.home import HomeLocation
from geometrikks.services.geoip.site_homes import (
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
