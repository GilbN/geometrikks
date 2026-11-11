"""The screenshot DROP import and documentation visitors against the real schema."""
from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx2
import pytest

from geometrikks.domain.drop.refresh import refresh_drop_lists
from geometrikks.domain.security.repositories import DropTrafficRepository
from tests.screenshots.doc_traffic import (
    DOC_DROP_NETWORKS,
    DOC_VISITORS,
    doc_traffic,
    write_doc_traffic,
)
from tests.screenshots.drop import (
    documentation_only_drop_lists,
    drop_marker_intact,
    feed_bodies,
    import_fixture_lists,
)
from tests.screenshots.fixture_ips import PROBE_PATHS, load_ip_stats
from tests.screenshots.lapi import load_events
from tests.seed.config import SeedConfig
from tests.seed.seeder import asyncpg_dsn
from tests.seed.traffic import Batch
from tests.seed.writer import SeedWriter

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)


async def test_fixture_import_makes_the_startup_refresh_skip(
    pg_session_maker, migrated_database_url, clean_tables
) -> None:
    bodies = feed_bodies(DOC_DROP_NETWORKS, now=NOW)
    outcomes = await import_fixture_lists(pg_session_maker, bodies, now=NOW)
    assert [o.status for o in outcomes] == ["imported", "imported", "imported"]

    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise AssertionError(f"network call to {request.url}")

    later = await refresh_drop_lists(
        pg_session_maker,
        now=NOW + timedelta(minutes=30),
        startup=True,
        refresh_hours=8760,
        transport=httpx2.MockTransport(refuse),
    )
    assert {o.status for o in later} == {"skipped"}

    conn = await asyncpg.connect(asyncpg_dsn(migrated_database_url))
    try:
        assert await drop_marker_intact(conn)
        assert await documentation_only_drop_lists(conn) == []
        await conn.execute("INSERT INTO drop_networks (cidr, sbl_id) VALUES ('100.64.0.0/24', 'SBLX')")
        await conn.execute("INSERT INTO drop_asns (asn) VALUES (14061)")
        assert await documentation_only_drop_lists(conn) == ["100.64.0.0/24", "AS14061"]
        await conn.execute("UPDATE drop_list_state SET copyright = 'Spamhaus' WHERE feed = 'asn'")
        assert not await drop_marker_intact(conn)
    finally:
        await conn.close()


async def test_doc_traffic_reaches_the_drop_card_without_a_location(
    pg_session_maker, migrated_database_url, clean_tables
) -> None:
    now = datetime.now(UTC)
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    conn = await asyncpg.connect(asyncpg_dsn(migrated_database_url))
    try:
        # The seed's newest rows and its refresh put the hourly watermark past
        # every documentation row, so only write_doc_traffic's own refresh
        # brings those rows into the aggregate leg.
        seed_row = doc_traffic(config, now=now, rng=random.Random(2)).access_logs[0]
        await SeedWriter(conn).write(
            Batch(access_logs=[seed_row._replace(ip_address="100.64.0.1", timestamp=now - timedelta(minutes=90))])
        )
        assert await SeedWriter(conn).refresh_aggregates() == []
        assert await write_doc_traffic(conn, config, now=now, rng=random.Random(1)) > 0
        await import_fixture_lists(pg_session_maker, feed_bodies(DOC_DROP_NETWORKS, now=now), now=now)
        stats = {s.ip: s for s in await load_ip_stats(conn, since=now - timedelta(days=7))}
        events = await load_events(conn, DOC_VISITORS)
    finally:
        await conn.close()
    assert all(stats[ip].recent_requests > 0 and stats[ip].location_id is None for ip in DOC_VISITORS)
    assert all(stats[ip].country_code is None and stats[ip].asn == 64496 for ip in DOC_VISITORS)
    assert set(events) == set(DOC_VISITORS)
    assert all(0 < len(rows) <= 6 and all(row.url in PROBE_PATHS for row in rows) for rows in events.values())
    async with pg_session_maker() as session:
        hits = {h.cidr: h for h in await DropTrafficRepository(session).network_hits(now - timedelta(days=7), now)}
    assert set(hits) == set(DOC_DROP_NETWORKS) and hits["203.0.113.0/24"].ips == 3
