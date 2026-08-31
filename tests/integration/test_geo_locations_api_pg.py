"""GeoLocation API through the full app composition on real TimescaleDB.

Exercises the production wiring end to end: create_app(settings=...) with the
SQLAlchemy + GeoAlchemy plugins, the GeoLocationService registered via
create_service_dependencies(), and the Advanced Alchemy limit_offset filter
dependencies, against the scratch integration database.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import structlog
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url

from geometrikks.config.settings import (
    DatabaseSettings,
    MapSettings,
    SchedulerSettings,
    Settings,
)
from geometrikks.server.core import create_app

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _reset_structlog_config():
    """Undo the StructlogPlugin's cache_logger_on_first_use configuration.

    Same rationale as in tests/test_app_factory.py: leaving it active would
    let later-bound loggers bypass structlog.testing.capture_logs() in other
    test modules. Re-running ensure_default_configuration() restores the
    import-time SuccessBoundLogger defaults that logger.success() callers
    (e.g. the importer) rely on.
    """
    from geometrikks.server.logging import ensure_default_configuration

    yield
    structlog.reset_defaults()
    ensure_default_configuration()


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    url = make_url(migrated_database_url)
    assert url.host is not None and url.username is not None
    assert url.password is not None and url.database is not None
    return Settings(
        auth_disabled=True,
        database=DatabaseSettings(
            host=url.host,
            port=url.port or 5432,
            user=url.username,
            password=url.password,
            database=url.database,
        ),
        scheduler=SchedulerSettings(enabled=False),
        # Static home location so startup never geolocates over the network.
        map=MapSettings(home_latitude=59.91, home_longitude=10.75),
    )


async def _seed_locations(session_maker, count: int) -> None:
    async with session_maker() as session:
        for i in range(count):
            await session.execute(
                text(
                    "INSERT INTO geo_locations "
                    "(geohash, latitude, longitude, geographic_point, country_code, "
                    " country_name, city, last_hit, created_at, updated_at) "
                    "VALUES (:geohash, :lat, :lon, "
                    " ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, "
                    " 'NO', 'Norway', :city, now(), now(), now())"
                ),
                {"geohash": f"glpg{i}", "lat": 59.0 + i, "lon": 10.0 + i, "city": f"City {i}"},
            )
        await session.commit()


async def _seed_country_events(session_maker) -> None:
    """Two countries, one city each, one hostname each, all inside the raw window."""
    async with session_maker() as session:
        location_ids = {}
        for geohash, code, name, city, lat, lon in (
            ("chapi1", "NO", "Norway", "Oslo", 59.91, 10.75),
            ("chapi2", "SE", "Sweden", "Umea", 63.83, 20.26),
        ):
            result = await session.execute(
                text(
                    "INSERT INTO geo_locations "
                    "(geohash, latitude, longitude, geographic_point, country_code, "
                    " country_name, city, last_hit, created_at, updated_at) "
                    "VALUES (:geohash, :lat, :lon, "
                    " ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, "
                    " :code, :name, :city, now(), now(), now()) "
                    "RETURNING id"
                ),
                {"geohash": geohash, "lat": lat, "lon": lon, "code": code,
                 "name": name, "city": city},
            )
            location_ids[code] = result.scalar_one()

        ts = datetime.now(timezone.utc) - timedelta(hours=1)
        for code, hostname, count in (("NO", "web-01", 5), ("SE", "web-02", 3)):
            for _ in range(count):
                await session.execute(
                    text(
                        "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                        "VALUES (:ts, '203.0.113.7', :hostname, :location_id)"
                    ),
                    {"ts": ts, "hostname": hostname, "location_id": location_ids[code]},
                )
        await session.commit()


async def test_country_stats_through_the_full_app(
    app_settings, pg_session_maker, clean_tables
):
    """The camelCase DTO shape plus the countryCode/city/hostnameIn aliases.

    The service takes `cities` and `hostnames` as the same `list[str] | None`,
    so swapping the two wires typechecks and passes every repository-level
    test. Filtering on a city name and on a hostname separately is what pins
    each alias to the argument it is meant to fill.
    """
    await _seed_country_events(pg_session_maker)
    span = {
        "fromTimestamp": (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat(),
        "toTimestamp": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }

    app = create_app(settings=app_settings)
    async with AsyncTestClient(app=app) as client:
        both = await client.get("/api/v1/geo-locations/country-stats", params=span)
        by_city = await client.get(
            "/api/v1/geo-locations/country-stats", params={**span, "city": "Oslo"}
        )
        by_hostname = await client.get(
            "/api/v1/geo-locations/country-stats", params={**span, "hostnameIn": "web-02"}
        )
        by_country = await client.get(
            "/api/v1/geo-locations/country-stats", params={**span, "countryCode": "se"}
        )

    assert both.status_code == 200
    rows = both.json()["countries"]
    assert {row["countryCode"]: row["eventCount"] for row in rows} == {"NO": 5, "SE": 3}
    assert set(rows[0]) == {"countryCode", "countryName", "eventCount"}
    assert {row["countryCode"]: row["countryName"] for row in rows} == {
        "NO": "Norway", "SE": "Sweden",
    }

    # A city filter routed into `hostnames` would match no rows at all.
    assert by_city.json()["countries"] == [
        {"countryCode": "NO", "countryName": "Norway", "eventCount": 5}
    ]
    # And a hostname filter routed into `cities` would do the same.
    assert by_hostname.json()["countries"] == [
        {"countryCode": "SE", "countryName": "Sweden", "eventCount": 3}
    ]
    assert [row["countryCode"] for row in by_country.json()["countries"]] == ["SE"]


async def test_country_stats_treats_a_naive_range_as_utc(
    app_settings, pg_session_maker, clean_tables
):
    """ensure_utc: an offset-less range must cover the same rows as a Z range."""
    await _seed_country_events(pg_session_maker)
    now = datetime.now(timezone.utc)

    app = create_app(settings=app_settings)
    async with AsyncTestClient(app=app) as client:
        response = await client.get(
            "/api/v1/geo-locations/country-stats",
            params={
                "fromTimestamp": (now - timedelta(hours=6)).replace(tzinfo=None).isoformat(),
                "toTimestamp": (now + timedelta(hours=1)).replace(tzinfo=None).isoformat(),
            },
        )

    assert response.status_code == 200
    counts = {row["countryCode"]: row["eventCount"] for row in response.json()["countries"]}
    assert counts == {"NO": 5, "SE": 3}


async def test_list_geo_locations_paginates_through_the_full_app(
    app_settings, pg_session_maker, clean_tables
):
    await _seed_locations(pg_session_maker, 5)

    app = create_app(settings=app_settings)
    async with AsyncTestClient(app=app) as client:
        page = await client.get(
            "/api/v1/geo-locations", params={"currentPage": 2, "pageSize": 2}
        )
        defaults = await client.get("/api/v1/geo-locations")

    assert page.status_code == 200
    body = page.json()
    assert body["total"] == 5
    assert body["limit"] == 2
    assert body["offset"] == 2
    assert len(body["items"]) == 2

    assert defaults.status_code == 200
    body = defaults.json()
    # Defaults must match the removed hand-written provider: page 1, size 10.
    assert body["limit"] == 10
    assert body["offset"] == 0
    assert body["total"] == 5
    assert len(body["items"]) == 5
    # Sanity-check one DTO row rather than the whole camelCase shape.
    assert {"id", "latitude", "longitude"} <= set(body["items"][0])
