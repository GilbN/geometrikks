"""ASN on geo events: backfill, aggregates, filters, facets (real TimescaleDB)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.integration.test_geo_logs_pg import _insert_location

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
RAW_START = NOW - timedelta(hours=23)


async def _insert_event(
    session, *, ts, ip: str, location_id: int, hostname: str = "web1",
    asn: int | None = None, org: str | None = None, n: int = 1,
) -> None:
    for _ in range(n):
        await session.execute(text(
            "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id, "
            " autonomous_system_number, autonomous_system_organization) "
            "VALUES (:ts, :ip, :hostname, :loc, :asn, :org)"
        ), {"ts": ts, "ip": ip, "hostname": hostname, "loc": location_id, "asn": asn, "org": org})


async def _one_location(session) -> int:
    return await _insert_location(
        session, geohash="asnloc", latitude=59.91, longitude=10.75,
        country_code="NO", country_name="Norway", city="Oslo",
    )


async def test_apply_asn_mapping_on_geo_events_fills_only_null_rows(pg_engine, pg_session_maker, clean_tables):
    from geometrikks.cli import _apply_asn_mapping, _iter_null_asn_ips

    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        loc = await _one_location(session)
        await _insert_event(session, ts=ts, ip="10.0.0.1", location_id=loc, n=2)
        await _insert_event(session, ts=ts, ip="10.0.0.1", location_id=loc, asn=999, org="Stamped Org")
        await _insert_event(session, ts=ts, ip="10.9.9.9", location_id=loc)
        await session.commit()

    pages = [page async for page in _iter_null_asn_ips(pg_engine, table="geo_events", chunk_size=10)]
    assert pages == [["10.0.0.1", "10.9.9.9"]]

    updated = await _apply_asn_mapping(pg_engine, [
        {"ip": "10.0.0.1", "asn": 24940, "org": "Hetzner Online GmbH"},
    ], table="geo_events")
    assert updated == 2

    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT host(ip_address), autonomous_system_number, autonomous_system_organization "
            "FROM geo_events"
        ))).all()
    assert sorted((r[0], r[1], r[2]) for r in rows) == [
        ("10.0.0.1", 999, "Stamped Org"),
        ("10.0.0.1", 24940, "Hetzner Online GmbH"),
        ("10.0.0.1", 24940, "Hetzner Online GmbH"),
        ("10.9.9.9", None, None),
    ]
