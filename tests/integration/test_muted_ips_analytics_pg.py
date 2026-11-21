"""excludeMutedIps on the Analytics endpoints, against real TimescaleDB through asyncpg."""
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

pytestmark = pytest.mark.anyio

NOW = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
SEED_HOUR = NOW - timedelta(days=2)
WEEK = {"startDate": (NOW - timedelta(days=7)).isoformat(), "endDate": NOW.isoformat()}
SEED_HOUR_ONLY = {"startDate": SEED_HOUR.isoformat(), "endDate": (SEED_HOUR + timedelta(minutes=30)).isoformat()}
MUTED = "203.0.113.7"
MAPPED = "::ffff:203.0.113.7"

# (ip, url, country, city, asn, hits)
TRAFFIC = [
    ("198.51.100.1", "/a", "NO", "Oslo", 64500, 3),
    ("198.51.100.2", "/b", "SE", "Umea", 64501, 2),
    (MUTED, "/a", "NO", "Oslo", 64500, 4),
    (MAPPED, "/a", "NO", "Oslo", 64500, 1),
]


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


@pytest.fixture()
async def traffic(pg_engine, pg_session_maker, clean_tables, clean_muted_ips):
    async with pg_session_maker() as session:
        for index, (ip, url, country, city, asn, hits) in enumerate(TRAFFIC):
            for hit in range(hits):
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, "
                        "request_time, user_agent, country_code, country_name, city, autonomous_system_number, "
                        "autonomous_system_organization) VALUES (:ts, :ip, 'GET', :url, 200, 100, 0.25, 'ua/1.0', "
                        ":country, :country, :city, :asn, 'Org')"
                    ),
                    {
                        "ts": SEED_HOUR + timedelta(minutes=index * 5 + hit),
                        "ip": ip, "url": url, "country": country, "city": city, "asn": asn,
                    },
                )
        await session.commit()
    failed = await refresh_caggs_range(pg_engine, start=NOW - timedelta(days=4), end=NOW)
    assert failed == []


async def mute(client: AsyncTestClient, network: str = MUTED + "/32") -> None:
    assert (await client.post("/api/v1/muted-ips/", json={"network": network})).status_code == 201


async def get(client: AsyncTestClient, endpoint: str, window: dict, **extra) -> dict:
    response = await client.get(f"/api/v1/analytics/{endpoint}", params={**window, **extra})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("window", [WEEK, SEED_HOUR_ONLY], ids=["aggregate", "raw"])
async def test_every_list_drops_the_muted_ip_and_its_mapped_form(client, traffic, window):
    await mute(client)
    flag = {"excludeMutedIps": "true"}

    series = await get(client, "time-series", window, **flag)
    assert sum(point["totalRequests"] for point in series["data"]) == 5
    urls = await get(client, "top-urls", window, **flag)
    assert [(item["url"], item["hits"]) for item in urls["items"]] == [("/a", 3), ("/b", 2)]
    asns = await get(client, "top-asns", window, **flag)
    assert [(item["asn"], item["hits"]) for item in asns["items"]] == [(64500, 3), (64501, 2)]
    assert (asns["totalRequests"], asns["totalBytes"]) == (5, 500)
    agents = await get(client, "top-user-agents", window, **flag)
    assert [(item["userAgent"], item["hits"]) for item in agents["items"]] == [("ua/1.0", 5)]
    ips = await get(client, "top-ips", window, **flag)
    assert [(item["ipAddress"], item["hits"]) for item in ips["items"]] == [("198.51.100.1", 3), ("198.51.100.2", 2)]
    assert ips["distinctIps"] == 2
    countries = await get(client, "top-countries", window, **flag)
    assert {item["countryCode"]: (item["hits"], item["uniqueIps"]) for item in countries["items"]} == {
        "NO": (3, 1),
        "SE": (2, 1),
    }
    cities = await get(client, "top-cities", window, **flag)
    assert {item["city"]: item["hits"] for item in cities["items"]} == {"Oslo": 3, "Umea": 2}


async def test_the_flag_off_keeps_everything(client, traffic):
    await mute(client)
    ips = await get(client, "top-ips", WEEK)
    assert {item["ipAddress"]: item["hits"] for item in ips["items"]} == {
        "198.51.100.1": 3, "198.51.100.2": 2, MUTED: 4, MAPPED: 1,
    }


async def test_an_ip_include_filter_wins(client, traffic):
    await mute(client)
    ips = await get(client, "top-ips", WEEK, excludeMutedIps="true", ipAddress=MUTED)
    assert [(item["ipAddress"], item["hits"]) for item in ips["items"]] == [(MUTED, 4)]


async def test_an_empty_list_matches_the_flag_off_answer(client, traffic):
    for endpoint in ("time-series", "top-urls", "top-user-agents", "top-asns", "top-ips", "top-countries", "top-cities"):
        assert await get(client, endpoint, WEEK, excludeMutedIps="true") == await get(client, endpoint, WEEK)


# (ip, host, url, hits)
HOSTED_TRAFFIC = [
    ("198.51.100.1", "a.example", "/a", 3),
    ("198.51.100.2", "b.example", "/b", 2),
    (MUTED, "a.example", "/a", 4),
    (MUTED, "b.example", "/b", 1),
]


@pytest.fixture()
async def hosted_traffic(pg_engine, pg_session_maker, clean_tables, clean_muted_ips):
    async with pg_session_maker() as session:
        for index, (ip, host, url, hits) in enumerate(HOSTED_TRAFFIC):
            for hit in range(hits):
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, host, method, url, status_code, bytes_sent, "
                        "request_time, user_agent, country_code, country_name, city, autonomous_system_number, "
                        "autonomous_system_organization) VALUES (:ts, :ip, :host, 'GET', :url, 200, 100, 0.25, "
                        "'ua/1.0', 'NO', 'NO', 'Oslo', 64500, 'Org')"
                    ),
                    {"ts": SEED_HOUR + timedelta(minutes=index * 5 + hit), "ip": ip, "host": host, "url": url},
                )
        await session.commit()
    failed = await refresh_caggs_range(pg_engine, start=NOW - timedelta(days=4), end=NOW)
    assert failed == []


# The week window would send a host-only Top URLs request to the URL rollups,
# which have no ip_address column; muting has to keep it on the raw rows.
@pytest.mark.parametrize("window", [WEEK, SEED_HOUR_ONLY], ids=["aggregate", "raw"])
async def test_a_host_filter_and_muting_apply_together(client, hosted_traffic, window):
    await mute(client)
    flag = {"excludeMutedIps": "true"}

    urls = await get(client, "top-urls", window, hostIn="a.example", **flag)
    assert [(item["host"], item["url"], item["hits"]) for item in urls["items"]] == [("a.example", "/a", 3)]
    ips = await get(client, "top-ips", window, hostIn="a.example", **flag)
    assert [(item["ipAddress"], item["hits"]) for item in ips["items"]] == [("198.51.100.1", 3)]

    urls = await get(client, "top-urls", window, hostNotIn="a.example", **flag)
    assert [(item["host"], item["url"], item["hits"]) for item in urls["items"]] == [("b.example", "/b", 2)]
    series = await get(client, "time-series", window, hostNotIn="a.example", **flag)
    assert sum(point["totalRequests"] for point in series["data"]) == 2
