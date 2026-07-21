"""Shapes for security-domain enrichment results."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IpEnrichment:
    """GeoMetrikks' own knowledge about one IP, joined onto ban decisions."""

    country_code: str | None
    country_name: str | None
    city: str | None
    request_count_24h: int


@dataclass
class IpLocation:
    """Latest known coordinates for one IP, for the map's banned overlay."""

    ip: str
    latitude: float
    longitude: float
    city: str | None
    country_code: str | None
