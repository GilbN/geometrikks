"""This server's location, from explicit coordinates or its public IP."""

from __future__ import annotations

import httpx2

from geometrikks.config.settings import GeoIPSettings, MapSettings
from geometrikks.services.geoip.self_location import resolve_self_location

import pytest

pytestmark = pytest.mark.anyio


async def test_configured_location_skips_public_ip_lookup():
    self_location = await resolve_self_location(
        MapSettings(server_latitude=40.7128, server_longitude=-74.006, _env_file=None),
        GeoIPSettings(_env_file=None),
        geoip_available=False,
    )

    assert self_location is not None
    assert (self_location.latitude, self_location.longitude, self_location.source) == (40.7128, -74.006, "configured")


async def test_external_ip_is_geolocated_with_local_database():
    def respond(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"ip": "81.2.69.142"}, request=request)

    async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as client:
        self_location = await resolve_self_location(
            MapSettings(auto_detect_server_location=True, _env_file=None),
            GeoIPSettings(
                db_path="tests/GeoLite2-City-Test.mmdb",
                _env_file=None,
            ),
            geoip_available=True,
            client=client,
        )

    assert self_location is not None
    assert self_location.source == "external_ip"
    assert self_location.latitude is not None
    assert self_location.longitude is not None


async def test_discovery_failure_degrades_without_raising():
    def respond(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(503, request=request)

    async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as client:
        self_location = await resolve_self_location(
            MapSettings(auto_detect_server_location=True, _env_file=None),
            GeoIPSettings(_env_file=None),
            geoip_available=True,
            client=client,
        )

    assert self_location is None
