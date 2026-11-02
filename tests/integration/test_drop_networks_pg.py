"""Per-network DROP traffic: the stitched CAGG read, origins and the endpoint on real TimescaleDB."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from litestar.testing import AsyncTestClient
from sqlalchemy import text

from geometrikks.domain.drop.snapshot import reset_drop_snapshot
from geometrikks.domain.geo.repositories import StatsGranularity, stitch_params
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


async def refresh_log_ip_caggs(pg_engine, now: datetime) -> None:
    await refresh_caggs_range(
        pg_engine,
        start=now - timedelta(days=100),
        end=now + timedelta(hours=1),
        caggs=["log_ip_hourly_stats", "log_ip_daily_stats"],
    )


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
    assert [network_traffic["cidr"] for network_traffic in second_page.json()["items"]] == [V6_NETWORK]


MAPPED_ROWS = [
    # The same client as 192.0.2.10 in mapped form, in the raw tail and in the CAGG range.
    ("::ffff:192.0.2.10", timedelta(minutes=10), None, None),
    ("::ffff:192.0.2.10", timedelta(days=2), None, None),
    # A client seen only in mapped form.
    ("::ffff:192.0.2.200", timedelta(days=3), None, None),
]


async def seed_mapped_rows(pg_session_maker, now: datetime) -> None:
    async with pg_session_maker() as session:
        for ip, age, asn, as_org in MAPPED_ROWS:
            await insert_log(session, ip=ip, age=age, now=now, asn=asn, as_org=as_org)
        await session.commit()


async def test_ipv4_mapped_clients_count_toward_the_ipv4_network(pg_session_maker, pg_engine, seeded):
    await seed_mapped_rows(pg_session_maker, seeded)
    expected = [
        (LONG_RANGE_NETWORK, "SBL000002", 7, 3),
        (SMALL_NETWORK, "SBL000001", 2, 1),
        (V6_NETWORK, "SBL000003", 1, 1),
    ]

    assert summarize(await read_hits(pg_session_maker, seeded, 30)) == expected
    await refresh_log_ip_caggs(pg_engine, seeded)
    assert summarize(await read_hits(pg_session_maker, seeded, 30)) == expected
    assert summarize(await read_hits(pg_session_maker, seeded, 90))[0] == (LONG_RANGE_NETWORK, "SBL000002", 8, 4)


async def test_ipv4_mapped_clients_feed_the_origins(pg_session_maker, seeded):
    async with pg_session_maker() as session:
        await insert_log(
            session, ip="::ffff:198.51.100.100", age=timedelta(minutes=1), now=seeded, asn=64499, as_org="MAPPED-AS"
        )
        await session.commit()
        origins = await DropTrafficRepository(session).network_origins(
            [SMALL_NETWORK], seeded - timedelta(days=30), seeded
        )

    small_origin = origins[SMALL_NETWORK]
    assert (small_origin.asn, small_origin.as_org) == (64499, "MAPPED-AS")
    assert abs(small_origin.last_seen - (seeded - timedelta(minutes=1))) < timedelta(seconds=1)


async def test_an_asn_logged_under_two_organization_names_counts_all_its_rows(pg_session_maker, clean_tables):
    await import_fixture_lists(pg_session_maker)
    now = datetime.now(UTC)
    # 64497 has five rows under two names, 64496 four under one; the busiest pair is 64496's.
    rows = [
        ("192.0.2.1", 64496, "A-ORG"),
        ("192.0.2.2", 64496, "A-ORG"),
        ("192.0.2.3", 64496, "A-ORG"),
        ("192.0.2.4", 64496, "A-ORG"),
        ("192.0.2.5", 64497, "Z-ORG"),
        ("192.0.2.6", 64497, "Z-ORG"),
        ("192.0.2.7", 64497, "Z-ORG"),
        ("192.0.2.8", 64497, "Z-ORG LTD"),
        ("192.0.2.9", 64497, "Z-ORG LTD"),
    ]
    async with pg_session_maker() as session:
        for ip, asn, as_org in rows:
            await insert_log(session, ip=ip, age=timedelta(hours=2), now=now, asn=asn, as_org=as_org)
        await session.commit()
        origins = await DropTrafficRepository(session).network_origins(
            [LONG_RANGE_NETWORK], now - timedelta(days=7), now
        )

    assert (origins[LONG_RANGE_NETWORK].asn, origins[LONG_RANGE_NETWORK].as_org) == (64497, "Z-ORG")


@pytest.mark.parametrize(
    ("days", "granularity"), [(30, StatsGranularity.HOURLY), (90, StatsGranularity.DAILY)]
)
@pytest.mark.parametrize("materialized", [False, True])
async def test_stitch_boundaries_count_every_request_once(
    pg_session_maker, pg_engine, clean_tables, days, granularity, materialized
):
    await import_fixture_lists(pg_session_maker)
    now = datetime.now(UTC)
    end = (now - timedelta(hours=1)).replace(minute=30, second=0, microsecond=0)
    start = end - timedelta(days=days)
    params = stitch_params(start, end, granularity)
    microsecond = timedelta(microseconds=1)
    # IP, timestamp, inside the window
    boundary_rows = [
        ("192.0.2.1", start - microsecond, False),
        ("192.0.2.2", start, True),
        ("192.0.2.3", params["a_start"] - microsecond, True),
        ("192.0.2.4", params["a_start"], True),
        ("192.0.2.5", params["a_end"] - microsecond, True),
        ("192.0.2.6", params["a_end"], True),
        ("192.0.2.7", end - microsecond, True),
        ("192.0.2.8", end, False),
    ]
    async with pg_session_maker() as session:
        for ip, timestamp, _ in boundary_rows:
            await insert_log(session, ip=ip, age=now - timestamp, now=now)
        await session.commit()
    if materialized:
        await refresh_log_ip_caggs(pg_engine, now)

    async with pg_session_maker() as session:
        drop_network_hits = await DropTrafficRepository(session).network_hits(start, end)

    inside_count = sum(1 for _, _, inside in boundary_rows if inside)
    assert summarize(drop_network_hits) == [(LONG_RANGE_NETWORK, "SBL000002", inside_count, inside_count)]


async def test_last_seen_falls_back_to_the_newest_bucket_when_raw_rows_are_gone(
    migrated_database_url, pg_session_maker, pg_engine, seeded, monkeypatch
):
    await refresh_log_ip_caggs(pg_engine, seeded)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM access_logs WHERE ip_address <<= '198.51.100.64/26'"))
    newest_bucket = (seeded - timedelta(days=5)).replace(minute=0, second=0, microsecond=0)

    drop_network_hits = {
        network.cidr: network for network in await read_hits(pg_session_maker, seeded, 30)
    }
    assert drop_network_hits[SMALL_NETWORK].last_seen == newest_bucket

    reset_drop_snapshot()
    monkeypatch.setattr(runtime, "get_crowdsec_service", lambda app: ClosableFakeCrowdSec([]))
    async with AsyncTestClient(app=create_app(settings=build_settings(migrated_database_url))) as client:
        response = await client.get("/api/v1/crowdsec/drop-networks?days=30")
    small_traffic = next(
        network_traffic for network_traffic in response.json()["items"] if network_traffic["cidr"] == SMALL_NETWORK
    )
    assert datetime.fromisoformat(small_traffic["lastSeen"]) == newest_bucket
    assert (small_traffic["asn"], small_traffic["asOrg"]) == (None, None)


NESTED_NETWORK = "192.0.2.0/25"


async def seed_nested_network(pg_session_maker, now: datetime) -> None:
    """A /25 inside the fixture /24, holding every seeded 192.0.2.x client but one in the upper half."""
    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO drop_networks (cidr, sbl_id) VALUES (:cidr, 'SBL000009')"
        ), {"cidr": NESTED_NETWORK})
        await insert_log(session, ip="192.0.2.200", age=timedelta(hours=2), now=now, asn=64501, as_org="UPPER-AS")
        await insert_log(session, ip="192.0.2.200", age=timedelta(days=2), now=now, asn=64501, as_org="UPPER-AS")
        await session.commit()


EXPECTED_NESTED_30_DAYS = [
    (NESTED_NETWORK, "SBL000009", 4, 2),
    (LONG_RANGE_NETWORK, "SBL000002", 2, 1),
    (SMALL_NETWORK, "SBL000001", 2, 1),
    (V6_NETWORK, "SBL000003", 1, 1),
]


async def test_a_client_in_nested_networks_counts_under_the_narrowest_only(pg_session_maker, pg_engine, seeded):
    await seed_nested_network(pg_session_maker, seeded)

    async with pg_session_maker() as session:
        raw_hits = await DropTrafficRepository(session).network_hits(seeded - timedelta(hours=12), seeded)
    assert summarize(raw_hits) == [(NESTED_NETWORK, "SBL000009", 2, 1), (LONG_RANGE_NETWORK, "SBL000002", 1, 1)]

    assert summarize(await read_hits(pg_session_maker, seeded, 30)) == EXPECTED_NESTED_30_DAYS
    await refresh_log_ip_caggs(pg_engine, seeded)
    assert summarize(await read_hits(pg_session_maker, seeded, 30)) == EXPECTED_NESTED_30_DAYS
    assert summarize(await read_hits(pg_session_maker, seeded, 90)) == [
        (NESTED_NETWORK, "SBL000009", 5, 3),
        (LONG_RANGE_NETWORK, "SBL000002", 2, 1),
        (SMALL_NETWORK, "SBL000001", 2, 1),
        (V6_NETWORK, "SBL000003", 1, 1),
    ]


async def test_origins_of_a_wider_network_leave_out_clients_of_a_nested_one(pg_session_maker, seeded):
    await seed_nested_network(pg_session_maker, seeded)

    async with pg_session_maker() as session:
        origins = await DropTrafficRepository(session).network_origins(
            [LONG_RANGE_NETWORK, NESTED_NETWORK], seeded - timedelta(days=30), seeded
        )

    assert (origins[NESTED_NETWORK].asn, origins[NESTED_NETWORK].as_org) == (64496, "EXAMPLE-AS")
    assert (origins[LONG_RANGE_NETWORK].asn, origins[LONG_RANGE_NETWORK].as_org) == (64501, "UPPER-AS")
    assert abs(origins[LONG_RANGE_NETWORK].last_seen - (seeded - timedelta(hours=2))) < timedelta(seconds=1)


async def test_the_endpoint_totals_count_a_nested_client_once(
    migrated_database_url, pg_session_maker, seeded, monkeypatch
):
    await seed_nested_network(pg_session_maker, seeded)
    reset_drop_snapshot()
    monkeypatch.setattr(runtime, "get_crowdsec_service", lambda app: ClosableFakeCrowdSec([]))

    async with AsyncTestClient(app=create_app(settings=build_settings(migrated_database_url))) as client:
        body = (await client.get("/api/v1/crowdsec/drop-networks?days=30")).json()

    assert (body["totalNetworks"], body["totalIps"], body["totalHits"]) == (4, 5, 9)
