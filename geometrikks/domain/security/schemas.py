"""Shapes for security-domain enrichment results."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

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


class BannedIp(msgspec.Struct, rename="camel"):
    """One badge entry: an IP under a decision and the type worth showing."""

    ip: str
    type: str


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


@dataclass(frozen=True)
class DropNetworkHits:
    """Traffic one DROP network sent in a window."""

    cidr: str
    sbl_id: str
    hits: int
    ips: int
    last_seen: datetime | None


@dataclass(frozen=True)
class DropNetworkOrigin:
    """Where a DROP network's traffic came from, read off its raw access_logs rows."""

    asn: int | None
    as_org: str | None
    last_seen: datetime


class BannedRangeView(msgspec.Struct, rename="camel"):
    """A CIDR under an active Range decision and the strongest type on it."""

    value: str
    type: str
    expires_at: datetime | None


class DropNetworkTrafficView(msgspec.Struct, rename="camel"):
    cidr: str
    sbl_id: str
    asn: int | None
    as_org: str | None
    hits: int
    ips: int
    # The newest raw request; the start of the newest CAGG bucket with traffic
    # once the raw rows have aged out; null only when neither holds any.
    last_seen: datetime | None
    decision: BannedRangeView | None


class DropNetworksResponse(msgspec.Struct, rename="camel"):
    loaded: bool
    days: int
    total_networks: int
    total_ips: int
    total_hits: int
    banned_networks: int
    # False when the LAPI could not be asked; every decision is null then.
    decisions_available: bool
    items: list[DropNetworkTrafficView]


MAX_BULK_BAN_NETWORKS = 1000


class BanNetworksRequest(msgspec.Struct, rename="camel"):
    """Ban DROP networks: name them, or ask for every unbanned one with traffic.

    Exactly one of ``networks`` and ``all_unbanned_days`` must be set.
    """

    duration: str
    networks: Annotated[list[str], msgspec.Meta(max_length=MAX_BULK_BAN_NETWORKS)] | None = None
    all_unbanned_days: Literal[7, 30, 90] | None = None


class BanNetworkResult(msgspec.Struct, rename="camel"):
    network: str
    ok: bool
    error: str | None
    # True when the network already held a Range decision and was left alone.
    already_banned: bool


class BanNetworksResponse(msgspec.Struct, rename="camel"):
    results: list[BanNetworkResult]
    # allUnbannedDays networks past the MAX_BULK_BAN_NETWORKS cap, not attempted.
    left_out: int
