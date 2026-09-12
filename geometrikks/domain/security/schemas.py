"""Shapes for security-domain enrichment results."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import msgspec

from geometrikks.domain.geo.dtos import GeoJSONPointGeometry


@dataclass
class IpEnrichment:
    """GeoMetrikks' own knowledge about one IP, joined onto ban decisions."""

    country_code: str | None
    country_name: str | None
    city: str | None
    request_count_24h: int


class IpLocation(msgspec.Struct, rename="camel"):
    """One IP's observed location and its event total in the filtered window."""

    ip: str
    location_id: int
    latitude: float
    longitude: float
    city: str | None
    country_code: str | None
    event_count: int


class BannedMapIp(msgspec.Struct, rename="camel", kw_only=True):
    ip: str
    location_id: int
    city: str | None
    country_code: str | None
    event_count: int


class BannedMapProperties(msgspec.Struct, rename="camel", kw_only=True):
    group_id: str
    ip_count: int
    banned_ips: list[BannedMapIp]


class BannedMapFeature(msgspec.Struct, rename="camel", kw_only=True):
    type: Literal["Feature"]
    id: str
    geometry: GeoJSONPointGeometry
    properties: BannedMapProperties


class BannedMapStats(msgspec.Struct, rename="camel"):
    """Totals over the mapped IPs, computed from the same list the features carry."""

    ips: int
    locations: int
    events: int
    countries: int
    cities: int


class BannedMapCollection(msgspec.Struct, rename="camel", kw_only=True):
    type: Literal["FeatureCollection"]
    features: list[BannedMapFeature]
    stats: BannedMapStats
