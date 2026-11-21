"""excludeMutedIps on Access Logs, Geo Logs and the Geo Logs map, against real TimescaleDB through asyncpg."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import structlog
from litestar.testing import AsyncTestClient
from sqlalchemy import text

from geometrikks.server.core import create_app
from geometrikks.server.logging import ensure_default_configuration
from geometrikks.server.timescale import refresh_caggs_range
from tests.integration.test_drop_snapshot_pg import build_settings
from tests.integration.test_geo_logs_pg import _insert_location

pytestmark = pytest.mark.anyio

NOW = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
SEED_HOUR = NOW - timedelta(days=2)
WEEK = {"fromTimestamp": (NOW - timedelta(days=7)).isoformat(), "toTimestamp": NOW.isoformat()}
RECENT = {
    "fromTimestamp": (NOW - timedelta(hours=6)).isoformat(),
    "toTimestamp": (NOW + timedelta(hours=1)).isoformat(),
}
MUTED = "203.0.113.7"
MAPPED = "::ffff:203.0.113.7"
FLAG = {"excludeMutedIps": "true"}

# (ip, location key, asn, hits)
TRAFFIC = [
    ("198.51.100.1", "no", 64500, 3),
    ("198.51.100.2", "se", 64501, 2),
    (MUTED, "no", 64500, 4),
    (MAPPED, "no", 64500, 1),
]
UNLISTED_ROWS = 5


@pytest.fixture()
def _reset_structlog_after_app():
    """Undo the StructlogPlugin's global configuration (see test_app_factory)."""
    yield
    structlog.reset_defaults()
    ensure_default_configuration()


@pytest.fixture()
async def client(migrated_database_url: str, _reset_structlog_after_app):
    async with AsyncTestClient(app=create_app(settings=build_settings(migrated_database_url))) as test_client:
        yield test_client


async def _seed(pg_session_maker, pg_engine, moment: datetime) -> None:
    async with pg_session_maker() as session:
        locations = {
            "no": await _insert_location(
                session, geohash="mutno", latitude=59.91, longitude=10.75,
                country_code="NO", country_name="Norway", city="Oslo",
            ),
            "se": await _insert_location(
                session, geohash="mutse", latitude=63.83, longitude=20.26,
                country_code="SE", country_name="Sweden", city="Umea",
            ),
        }
        for index, (ip, location, asn, hits) in enumerate(TRAFFIC):
            for hit in range(hits):
                timestamp = moment + timedelta(minutes=index * 5 + hit)
                await session.execute(
                    text(
                        "INSERT INTO geo_events (timestamp, ip_address, server, location_id, "
                        "autonomous_system_number, autonomous_system_organization) "
                        "VALUES (:ts, :ip, 'web1', :loc, :asn, 'Org')"
                    ),
                    {"ts": timestamp, "ip": ip, "loc": locations[location], "asn": asn},
                )
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, "
                        "user_agent) VALUES (:ts, :ip, 'GET', '/a', 200, 100, 'ua/1.0')"
                    ),
                    {"ts": timestamp, "ip": ip},
                )
        await session.commit()
    failed = await refresh_caggs_range(pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1))
    assert failed == []


@pytest.fixture(params=["aggregate", "raw"])
async def traffic(request, pg_engine, pg_session_maker, clean_tables, clean_muted_ips):
    """Seeded two days back (read through the aggregates) or three hours back (read raw); returns the window."""
    if request.param == "aggregate":
        await _seed(pg_session_maker, pg_engine, SEED_HOUR)
        return WEEK
    await _seed(pg_session_maker, pg_engine, NOW - timedelta(hours=3))
    return RECENT


async def mute(client: AsyncTestClient, network: str = MUTED + "/32") -> None:
    assert (await client.post("/api/v1/muted-ips/", json={"network": network})).status_code == 201


async def get(client: AsyncTestClient, path: str, window: dict, **extra) -> dict:
    response = await client.get(f"/api/v1{path}", params={**window, **extra})
    assert response.status_code == 200, response.text
    return response.json()


async def test_access_logs_drop_the_muted_ip_and_count_only_the_rest(client, traffic):
    await mute(client)
    body = await get(client, "/access-logs/", {}, **FLAG)
    assert body["total"] == UNLISTED_ROWS
    assert {item["ipAddress"] for item in body["items"]} == {"198.51.100.1", "198.51.100.2"}
    unfiltered = await get(client, "/access-logs/", {})
    assert unfiltered["total"] == 10


async def test_access_logs_include_wins(client, traffic):
    await mute(client)
    body = await get(client, "/access-logs/", {}, ipAddressIn=MUTED, **FLAG)
    assert body["total"] == 4
    assert {item["ipAddress"] for item in body["items"]} == {MUTED}


async def test_geo_logs_endpoints_drop_the_muted_ip(client, traffic):
    await mute(client)
    base = traffic

    summary = await get(client, "/geo-events/summary", base, **FLAG)
    assert summary["currentPeriod"]["totalEvents"] == UNLISTED_ROWS
    assert summary["currentPeriod"]["uniqueIps"] == 2
    logs = await get(client, "/geo-events/logs", base, **FLAG)
    assert {item["ipAddress"]: item["eventCount"] for item in logs["items"]} == {"198.51.100.1": 3, "198.51.100.2": 2}
    series = await get(client, "/geo-events/time-series", base, **FLAG)
    assert sum(point["totalEvents"] for point in series["data"]) == UNLISTED_ROWS
    ips = await get(client, "/geo-events/top-ips", base, **FLAG)
    assert {item["ipAddress"]: item["eventCount"] for item in ips["items"]} == {"198.51.100.1": 3, "198.51.100.2": 2}
    countries = await get(client, "/geo-events/top-countries", base, **FLAG)
    assert {item["countryCode"]: (item["eventCount"], item["uniqueIps"]) for item in countries["items"]} == {
        "NO": (3, 1),
        "SE": (2, 1),
    }
    cities = await get(client, "/geo-events/top-cities", base, **FLAG)
    assert {item["city"]: item["eventCount"] for item in cities["items"]} == {"Oslo": 3, "Umea": 2}
    asns = await get(client, "/geo-events/top-asns", base, **FLAG)
    assert {item["asn"]: item["eventCount"] for item in asns["items"]} == {64500: 3, 64501: 2}
    geojson = await get(client, "/geo-locations/geojson", base, **FLAG)
    assert {feature["properties"]["city"]: feature["properties"]["eventCount"] for feature in geojson["features"]} == {
        "Oslo": 3,
        "Umea": 2,
    }
    assert geojson["stats"]["events"] == UNLISTED_ROWS


async def test_the_flag_off_keeps_everything(client, traffic):
    await mute(client)
    ips = await get(client, "/geo-events/top-ips", traffic)
    assert {item["ipAddress"]: item["eventCount"] for item in ips["items"]} == {
        "198.51.100.1": 3, "198.51.100.2": 2, MUTED: 4, MAPPED: 1,
    }
    assert (await get(client, "/geo-locations/geojson", traffic))["stats"]["events"] == 10


async def test_geo_ip_include_wins(client, traffic):
    await mute(client)
    ips = await get(client, "/geo-events/top-ips", traffic, ipAddressIn=MUTED, **FLAG)
    assert {item["ipAddress"]: item["eventCount"] for item in ips["items"]} == {MUTED: 4}


async def test_geojson_include_wins(client, traffic):
    await mute(client)
    geojson = await get(client, "/geo-locations/geojson", traffic, ipAddressIn=MUTED, **FLAG)
    assert [(feature["properties"]["city"], feature["properties"]["eventCount"]) for feature in geojson["features"]] == [
        ("Oslo", 4)
    ]


async def test_an_empty_list_matches_the_flag_off_answer(client, traffic):
    for path in ("/geo-events/summary", "/geo-events/time-series", "/geo-events/top-ips", "/geo-events/top-cities"):
        assert await get(client, path, traffic, **FLAG) == await get(client, path, traffic)
