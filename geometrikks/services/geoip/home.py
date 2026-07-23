"""Resolve the effective home coordinate used by live map routes."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Literal

import httpx
from geoip2.database import Reader
from geoip2.errors import GeoIP2Error

from geometrikks.config.settings import GeoIPSettings, MapSettings
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

HomeLocationSource = Literal["configured", "external_ip"]


@dataclass(frozen=True)
class HomeLocation:
    """Effective map destination without exposing the discovered public IP."""

    latitude: float
    longitude: float
    source: HomeLocationSource


async def _fetch_public_ip(settings: MapSettings, client: httpx.AsyncClient) -> str:
    response = await client.get(settings.public_ip_url)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("ip"), str):
        raise ValueError("public-IP response must be a JSON object containing an 'ip' string")
    address = ipaddress.ip_address(payload["ip"])
    if not address.is_global:
        raise ValueError("public-IP service returned a non-global address")
    return str(address)


async def resolve_home_location(
    map_settings: MapSettings,
    geoip_settings: GeoIPSettings,
    *,
    geoip_available: bool,
    client: httpx.AsyncClient | None = None,
) -> HomeLocation | None:
    """Resolve configured coordinates or geolocate the server's public IP.

    Discovery is best-effort. Network, response, database, and missing-coordinate
    failures leave the animation without a destination instead of failing startup.
    """
    if map_settings.home_latitude is not None and map_settings.home_longitude is not None:
        return HomeLocation(
            latitude=map_settings.home_latitude,
            longitude=map_settings.home_longitude,
            source="configured",
        )
    if not map_settings.auto_detect_home or not geoip_available:
        return None

    try:
        if client is None:
            timeout = httpx.Timeout(map_settings.public_ip_timeout)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as owned_client:
                public_ip = await _fetch_public_ip(map_settings, owned_client)
        else:
            public_ip = await _fetch_public_ip(map_settings, client)

        with Reader(geoip_settings.db_path, locales=geoip_settings.locales) as reader:
            city = reader.city(public_ip)
        latitude = city.location.latitude
        longitude = city.location.longitude
        if latitude is None or longitude is None:
            raise ValueError("GeoIP lookup returned no coordinates")
        return HomeLocation(latitude=latitude, longitude=longitude, source="external_ip")
    except (GeoIP2Error, httpx.HTTPError, OSError, ValueError) as exc:
        logger.warning(
            "Could not auto-detect map home location: %s. Set MAP_HOME_LATITUDE "
            "and MAP_HOME_LONGITUDE to override it.",
            exc,
        )
        return None
