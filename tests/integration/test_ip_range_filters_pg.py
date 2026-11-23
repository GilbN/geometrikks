"""CIDR ranges in the IP include/exclude filters, against real TimescaleDB through asyncpg."""
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
GEO_WEEK = {"fromTimestamp": (NOW - timedelta(days=7)).isoformat(), "toTimestamp": NOW.isoformat()}
GEO_RECENT = {
    "fromTimestamp": (NOW - timedelta(hours=6)).isoformat(),
    "toTimestamp": (NOW + timedelta(hours=1)).isoformat(),
}
ANALYTICS_WEEK = {"startDate": GEO_WEEK["fromTimestamp"], "endDate": GEO_WEEK["toTimestamp"]}
ANALYTICS_RECENT = {"startDate": GEO_RECENT["fromTimestamp"], "endDate": GEO_RECENT["toTimestamp"]}

V4_RANGE = "198.51.100.0/24"
V6_RANGE = "2001:db8:1:2::/64"
LONE = "203.0.113.7"

# (ip, location key, hits)
TRAFFIC = [
    ("198.51.100.1", "no", 3),
    ("198.51.100.200", "se", 2),
    ("::ffff:198.51.100.9", "no", 1),
    ("2001:db8:1:2::5", "se", 2),
    ("2001:db8:1:2:ffff::1", "no", 1),
    ("2001:db8:1:3::1", "no", 4),
    (LONE, "no", 5),
]
TOTAL = sum(hits for _, _, hits in TRAFFIC)
IN_V4_RANGE = {"198.51.100.1": 3, "198.51.100.200": 2, "::ffff:198.51.100.9": 1}
IN_V6_RANGE = {"2001:db8:1:2::5": 2, "2001:db8:1:2:ffff::1": 1}


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
                session, geohash="cidrno", latitude=59.91, longitude=10.75,
                country_code="NO", country_name="Norway", city="Oslo",
            ),
            "se": await _insert_location(
                session, geohash="cidrse", latitude=63.83, longitude=20.26,
                country_code="SE", country_name="Sweden", city="Umea",
            ),
        }
        for index, (ip, location, hits) in enumerate(TRAFFIC):
            for hit in range(hits):
                timestamp = moment + timedelta(minutes=index * 5 + hit)
                await session.execute(
                    text(
                        "INSERT INTO geo_events (timestamp, ip_address, server, location_id, "
                        "autonomous_system_number, autonomous_system_organization) "
                        "VALUES (:ts, :ip, 'web1', :loc, 64500, 'Org')"
                    ),
                    {"ts": timestamp, "ip": ip, "loc": locations[location]},
                )
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, "
                        "request_time, user_agent, country_code, country_name, city, autonomous_system_number, "
                        "autonomous_system_organization) VALUES (:ts, :ip, 'GET', '/a', 200, 100, 0.25, 'ua/1.0', "
                        "'NO', 'Norway', 'Oslo', 64500, 'Org')"
                    ),
                    {"ts": timestamp, "ip": ip},
                )
        await session.commit()
    failed = await refresh_caggs_range(pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1))
    assert failed == []


@pytest.fixture(params=["aggregate", "raw"])
async def windows(request, pg_engine, pg_session_maker, clean_tables, clean_muted_ips):
    """Seeded two days back (read through the aggregates) or three hours back (read raw)."""
    if request.param == "aggregate":
        await _seed(pg_session_maker, pg_engine, SEED_HOUR)
        return GEO_WEEK, ANALYTICS_WEEK
    await _seed(pg_session_maker, pg_engine, NOW - timedelta(hours=3))
    return GEO_RECENT, ANALYTICS_RECENT


async def get(client: AsyncTestClient, path: str, params: dict) -> dict:
    response = await client.get(f"/api/v1{path}", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _hits_by_ip(items: list[dict], count_key: str) -> dict[str, int]:
    return {item["ipAddress"]: item[count_key] for item in items}


async def test_access_logs_take_ranges_in_both_directions(client, windows):
    included = await get(client, "/access-logs/", {"ipAddressIn": [V4_RANGE, LONE], "pageSize": 100})
    assert included["total"] == sum(IN_V4_RANGE.values()) + 5
    assert {item["ipAddress"] for item in included["items"]} == {*IN_V4_RANGE, LONE}

    excluded = await get(client, "/access-logs/", {"ipAddressNotIn": [V4_RANGE, V6_RANGE]})
    assert excluded["total"] == TOTAL - sum(IN_V4_RANGE.values()) - sum(IN_V6_RANGE.values())


async def test_an_include_range_wins_over_the_muted_list(client, windows):
    assert (await client.post("/api/v1/muted-ips/", json={"network": V4_RANGE})).status_code == 201
    body = await get(client, "/access-logs/", {"ipAddressIn": V4_RANGE, "excludeMutedIps": "true"})
    assert body["total"] == sum(IN_V4_RANGE.values())


async def test_geo_logs_and_the_map_take_ranges(client, windows):
    geo_window, _ = windows
    ips = await get(client, "/geo-events/top-ips", {**geo_window, "ipAddressIn": V6_RANGE})
    assert _hits_by_ip(ips["items"], "eventCount") == IN_V6_RANGE

    ips = await get(client, "/geo-events/top-ips", {**geo_window, "ipAddressNotIn": [V4_RANGE, V6_RANGE]})
    assert _hits_by_ip(ips["items"], "eventCount") == {"2001:db8:1:3::1": 4, LONE: 5}

    events = await get(client, "/geo-events/", {**geo_window, "ipAddressIn": V4_RANGE, "pageSize": 100})
    assert events["total"] == sum(IN_V4_RANGE.values())

    geojson = await get(client, "/geo-locations/geojson", {**geo_window, "ipAddressIn": V4_RANGE})
    assert {feature["properties"]["city"]: feature["properties"]["eventCount"] for feature in geojson["features"]} == {
        "Oslo": 4,
        "Umea": 2,
    }


async def test_analytics_take_ranges(client, windows):
    _, analytics_window = windows
    ips = await get(client, "/analytics/top-ips", {**analytics_window, "ipAddress": V4_RANGE})
    assert _hits_by_ip(ips["items"], "hits") == IN_V4_RANGE

    series = await get(client, "/analytics/time-series", {**analytics_window, "ipAddressNotIn": V6_RANGE})
    assert sum(point["totalRequests"] for point in series["data"]) == TOTAL - sum(IN_V6_RANGE.values())


async def test_an_include_range_minus_an_excluded_subrange(client, windows):
    geo_window, analytics_window = windows
    both = {"ipAddressIn": V4_RANGE, "ipAddressNotIn": "198.51.100.0/25"}
    logs = await get(client, "/access-logs/", both)
    assert {item["ipAddress"] for item in logs["items"]} == {"198.51.100.200"}
    geo_ips = await get(client, "/geo-events/top-ips", {**geo_window, **both})
    assert _hits_by_ip(geo_ips["items"], "eventCount") == {"198.51.100.200": 2}
    analytics_ips = await get(
        client, "/analytics/top-ips", {**analytics_window, "ipAddress": V4_RANGE, "ipAddressNotIn": "198.51.100.0/25"}
    )
    assert _hits_by_ip(analytics_ips["items"], "hits") == {"198.51.100.200": 2}


@pytest.mark.parametrize("value", ["198.51.100.9", "198.51.100.9/32", "::ffff:198.51.100.9"])
async def test_a_single_ipv4_address_also_matches_its_mapped_form(client, windows, value):
    body = await get(client, "/access-logs/", {"ipAddressIn": value})
    assert {item["ipAddress"] for item in body["items"]} == {"::ffff:198.51.100.9"}


async def test_debug_logs_take_ranges(client, pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        for ip in ("198.51.100.4", "::ffff:198.51.100.5", "192.0.2.1", None):
            await session.execute(
                text("INSERT INTO access_log_debug (created_at, raw_line, is_malformed, ip_address) "
                    "VALUES (:ts, 'line', false, :ip)"),
                {"ts": NOW, "ip": ip},
            )
        await session.commit()
    body = await get(client, "/access-log-debug/", {"ipAddressIn": V4_RANGE})
    assert sorted(item["ipAddress"] for item in body["items"]) == ["198.51.100.4", "::ffff:198.51.100.5"]


@pytest.mark.parametrize(
    ("path", "params"),
    [
        ("/access-logs/", {"ipAddressIn": "198.51.100.7/24"}),
        ("/geo-events/top-ips", {**GEO_WEEK, "ipAddressNotIn": "198.51.100.7/24"}),
        ("/analytics/top-ips", {**ANALYTICS_WEEK, "ipAddress": "198.51.100.7/24"}),
    ],
)
async def test_a_range_with_host_bits_is_a_400(client, path, params):
    response = await client.get(f"/api/v1{path}", params=params)
    assert (response.status_code, response.json()["code"]) == (400, "invalid_network")
    assert "198.51.100.0/24" in response.json()["detail"]
