"""GET /api/v1/geo-locations/site-homes through the full app composition.

Same pattern as test_geo_locations_api_pg.py: create_app(settings=...) against
the scratch integration database, exercised through AsyncTestClient.
"""
from __future__ import annotations

import pytest
import structlog
from litestar.testing import AsyncTestClient
from sqlalchemy.engine import make_url

from geometrikks.config.settings import (
    DatabaseSettings,
    LogParserSettings,
    MapSettings,
    SchedulerSettings,
    Settings,
)
from geometrikks.server.core import create_app
from geometrikks.services.geoip.home import HomeLocation
from geometrikks.services.geoip.site_homes import upsert_auto_homes

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _reset_structlog_config():
    """See test_geo_locations_api_pg.py: undo StructlogPlugin's global config
    so later capture_logs() calls in other modules are not bypassed."""
    from geometrikks.server.logging import ensure_default_configuration

    yield
    structlog.reset_defaults()
    ensure_default_configuration()


def _make_settings(migrated_database_url: str, **map_kwargs) -> Settings:
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
        # Ingestion disabled: its own startup auto-upsert would otherwise add
        # this machine's hostname to site_homes and pollute the assertions.
        logparser=LogParserSettings(enabled=False),
        # Static home location so startup never geolocates over the network.
        map=MapSettings(home_latitude=59.91, home_longitude=10.75, **map_kwargs),
    )


async def test_site_homes_endpoint_returns_merged_rows_and_default(
    migrated_database_url, pg_session_maker, clean_site_homes
):
    await upsert_auto_homes(
        pg_session_maker, ["nginx-01"], HomeLocation(latitude=60.39, longitude=5.32, source="external_ip")
    )
    # The override row comes from MAP_HOME_LOCATIONS, reconciled into
    # site_homes by the app's own startup lifecycle (not seeded directly):
    # that reconcile always runs and would otherwise delete an override row
    # not present in this settings object.
    settings = _make_settings(migrated_database_url, home_locations={"nginx-02": (51.5, -0.12)})

    app = create_app(settings=settings)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/geo-locations/site-homes")

    assert resp.status_code == 200
    body = resp.json()
    homes = {h["hostname"]: h for h in body["homes"]}
    assert homes["nginx-01"]["source"] == "auto"
    assert homes["nginx-01"]["latitude"] == pytest.approx(60.39)
    assert homes["nginx-01"]["longitude"] == pytest.approx(5.32)
    assert homes["nginx-01"]["detectedAt"] is not None
    assert homes["nginx-02"]["source"] == "override"
    assert homes["nginx-02"]["latitude"] == pytest.approx(51.5)
    assert homes["nginx-02"]["detectedAt"] is None
    assert body["default"] == {"latitude": 59.91, "longitude": 10.75}


async def test_site_homes_endpoint_empty_with_no_rows(migrated_database_url, clean_site_homes):
    settings = _make_settings(migrated_database_url)
    app = create_app(settings=settings)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/geo-locations/site-homes")

    assert resp.status_code == 200
    body = resp.json()
    assert body["homes"] == []
    assert body["default"] == {"latitude": 59.91, "longitude": 10.75}
