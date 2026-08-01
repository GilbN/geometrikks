"""GeoLocation API through the full app composition on real TimescaleDB.

Exercises the production wiring end to end: create_app(settings=...) with the
SQLAlchemy + GeoAlchemy plugins, the GeoLocationService registered via
create_service_dependencies(), and the Advanced Alchemy limit_offset filter
dependencies, against the scratch integration database.
"""
from __future__ import annotations

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
