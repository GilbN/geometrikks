"""Map-home resolution from explicit coordinates or the server's public IP."""

from __future__ import annotations

import httpx

from geometrikks.config.settings import GeoIPSettings, MapSettings
from geometrikks.services.geoip.home import resolve_home_location


async def test_configured_home_skips_public_ip_lookup():
    home = await resolve_home_location(
        MapSettings(home_latitude=40.7128, home_longitude=-74.006, _env_file=None),
        GeoIPSettings(validate_db_path=False, _env_file=None),
        geoip_available=False,
    )

    assert home is not None
    assert (home.latitude, home.longitude, home.source) == (40.7128, -74.006, "configured")


async def test_external_ip_is_geolocated_with_local_database():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ip": "81.2.69.142"}, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        home = await resolve_home_location(
            MapSettings(auto_detect_home=True, _env_file=None),
            GeoIPSettings(
                db_path="tests/GeoLite2-City-Test.mmdb",
                validate_db_path=True,
                _env_file=None,
            ),
            geoip_available=True,
            client=client,
        )

    assert home is not None
    assert home.source == "external_ip"
    assert home.latitude is not None
    assert home.longitude is not None


async def test_discovery_failure_degrades_without_raising():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        home = await resolve_home_location(
            MapSettings(auto_detect_home=True, _env_file=None),
            GeoIPSettings(validate_db_path=False, _env_file=None),
            geoip_available=True,
            client=client,
        )

    assert home is None
