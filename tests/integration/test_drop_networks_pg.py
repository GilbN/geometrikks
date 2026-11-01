"""Per-network DROP traffic: the stitched CAGG read, origins and the endpoint on real TimescaleDB."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from litestar.testing import AsyncTestClient
from sqlalchemy import text

from geometrikks.domain.drop.snapshot import reset_drop_snapshot
from geometrikks.domain.security.repositories import DropTrafficRepository
from geometrikks.domain.security.schemas import DropNetworkHits
from geometrikks.server import runtime
from geometrikks.server.core import create_app
from geometrikks.server.timescale import refresh_caggs_range
from tests.integration.test_drop_snapshot_pg import build_settings, import_fixture_lists
from tests.test_crowdsec_controller import FakeCrowdSec, range_decision

pytestmark = pytest.mark.anyio


class ClosableFakeCrowdSec(FakeCrowdSec):
    """The app lifespan closes the service it finds on app state at shutdown."""

    async def aclose(self) -> None:
        return None


# Fixture lists: 192.0.2.0/24 SBL000002, 198.51.100.64/26 SBL000001, 2001:db8:254::/48 SBL000003.
LONG_RANGE_NETWORK = "192.0.2.0/24"
SMALL_NETWORK = "198.51.100.64/26"
V6_NETWORK = "2001:db8:254::/48"


async def insert_log(session, *, ip: str, age: timedelta, now: datetime, asn: int | None = None, as_org: str | None = None):
    await session.execute(
        text(
            "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, "
            "request_time, autonomous_system_number, autonomous_system_organization) "
            "VALUES (:timestamp, :ip, 'GET', '/x', 200, 100, 0.01, :asn, :as_org)"
        ),
        {"timestamp": now - age, "ip": ip, "asn": asn, "as_org": as_org},
    )


async def seed_traffic(pg_session_maker, now: datetime) -> None:
    """Two DROP networks in the last 30 days, a v6 one 20 days back, one 40 days back and a clean IP."""
    rows = [
        ("192.0.2.10", timedelta(minutes=10), 64496, "EXAMPLE-AS"),
        ("192.0.2.10", timedelta(hours=3), 64496, "EXAMPLE-AS"),
        ("192.0.2.10", timedelta(days=2), 64496, "EXAMPLE-AS"),
        ("192.0.2.77", timedelta(days=2), 64497, "OTHER-AS"),
        ("192.0.2.99", timedelta(days=40), 64496, "EXAMPLE-AS"),
        ("198.51.100.100", timedelta(days=5), None, None),
        ("198.51.100.100", timedelta(days=5, hours=1), None, None),
        ("198.51.100.5", timedelta(hours=1), 64500, "CLEAN-AS"),
        ("2001:db8:254::1", timedelta(days=20), 64511, "V6-AS"),
        ("10.0.0.1", timedelta(minutes=5), None, None),
    ]
    async with pg_session_maker() as session:
        for ip, age, asn, as_org in rows:
            await insert_log(session, ip=ip, age=age, now=now, asn=asn, as_org=as_org)
        await session.commit()


def summarize(hits: list[DropNetworkHits]) -> list[tuple[str, str, int, int]]:
    return [(network.cidr, network.sbl_id, network.hits, network.ips) for network in hits]


async def read_hits(pg_session_maker, now: datetime, days: int) -> list[DropNetworkHits]:
    async with pg_session_maker() as session:
        return await DropTrafficRepository(session).network_hits(now - timedelta(days=days), now)


@pytest.fixture()
async def seeded(pg_session_maker, clean_tables) -> datetime:
    await import_fixture_lists(pg_session_maker)
    now = datetime.now(UTC)
    await seed_traffic(pg_session_maker, now)
    return now


EXPECTED_30_DAYS = [
    (LONG_RANGE_NETWORK, "SBL000002", 4, 2),
    (SMALL_NETWORK, "SBL000001", 2, 1),
    (V6_NETWORK, "SBL000003", 1, 1),
]


async def test_hits_per_network_come_busiest_first(pg_session_maker, seeded):
    assert summarize(await read_hits(pg_session_maker, seeded, 30)) == EXPECTED_30_DAYS


async def test_the_cagg_read_equals_the_raw_tail_read(pg_session_maker, pg_engine, seeded):
    unmaterialized = await read_hits(pg_session_maker, seeded, 30)
    await refresh_caggs_range(
        pg_engine, start=seeded - timedelta(days=100), end=seeded + timedelta(hours=1), caggs=["log_ip_hourly_stats"]
    )
    materialized = await read_hits(pg_session_maker, seeded, 30)

    assert summarize(unmaterialized) == EXPECTED_30_DAYS
    assert summarize(materialized) == EXPECTED_30_DAYS


async def test_ninety_days_reads_the_daily_cagg_and_includes_older_traffic(pg_session_maker, pg_engine, seeded):
    await refresh_caggs_range(
        pg_engine, start=seeded - timedelta(days=100), end=seeded + timedelta(hours=1), caggs=["log_ip_daily_stats"]
    )

    hits = await read_hits(pg_session_maker, seeded, 90)

    assert summarize(hits) == [
        (LONG_RANGE_NETWORK, "SBL000002", 5, 3),
        (SMALL_NETWORK, "SBL000001", 2, 1),
        (V6_NETWORK, "SBL000003", 1, 1),
    ]


async def test_seven_days_leaves_out_older_networks(pg_session_maker, seeded):
    assert summarize(await read_hits(pg_session_maker, seeded, 7)) == [
        (LONG_RANGE_NETWORK, "SBL000002", 4, 2),
        (SMALL_NETWORK, "SBL000001", 2, 1),
    ]


async def test_a_window_of_a_day_or_less_reads_raw_rows(pg_session_maker, seeded):
    async with pg_session_maker() as session:
        hits = await DropTrafficRepository(session).network_hits(seeded - timedelta(hours=12), seeded)

    assert summarize(hits) == [(LONG_RANGE_NETWORK, "SBL000002", 2, 1)]


async def test_origins_give_the_commonest_asn_and_the_newest_request(pg_session_maker, seeded):
    async with pg_session_maker() as session:
        origins = await DropTrafficRepository(session).network_origins(
            [LONG_RANGE_NETWORK, SMALL_NETWORK], seeded - timedelta(days=30), seeded
        )

    long_range_origin = origins[LONG_RANGE_NETWORK]
    assert (long_range_origin.asn, long_range_origin.as_org) == (64496, "EXAMPLE-AS")
    assert abs(long_range_origin.last_seen - (seeded - timedelta(minutes=10))) < timedelta(seconds=1)
    small_origin = origins[SMALL_NETWORK]
    assert (small_origin.asn, small_origin.as_org) == (None, None)
    assert V6_NETWORK not in origins


async def test_origins_for_no_networks_is_empty(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        origins = await DropTrafficRepository(session).network_origins([], datetime.now(UTC), datetime.now(UTC))

    assert origins == {}


async def test_the_endpoint_pages_the_traffic_and_fills_decisions(
    migrated_database_url, pg_session_maker, seeded, monkeypatch
):
    reset_drop_snapshot()
    fake_crowdsec = ClosableFakeCrowdSec([range_decision(LONG_RANGE_NETWORK)])
    monkeypatch.setattr(runtime, "get_crowdsec_service", lambda app: fake_crowdsec)

    async with AsyncTestClient(app=create_app(settings=build_settings(migrated_database_url))) as client:
        response = await client.get("/api/v1/crowdsec/drop-networks?days=30&page=1&pageSize=2")
        second_page = await client.get("/api/v1/crowdsec/drop-networks?days=30&page=2&pageSize=2")

    assert response.status_code == 200
    body = response.json()
    assert (body["loaded"], body["totalNetworks"], body["totalIps"], body["totalHits"], body["bannedNetworks"]) == (
        True, 3, 4, 7, 1,
    )
    first, second = body["items"]
    assert (first["cidr"], first["sblId"], first["asn"], first["asOrg"], first["hits"], first["ips"]) == (
        LONG_RANGE_NETWORK, "SBL000002", 64496, "EXAMPLE-AS", 4, 2,
    )
    assert first["decision"]["value"] == LONG_RANGE_NETWORK
    assert first["lastSeen"] is not None
    assert (second["cidr"], second["asn"], second["decision"]) == (SMALL_NETWORK, None, None)
    assert [item["cidr"] for item in second_page.json()["items"]] == [V6_NETWORK]
