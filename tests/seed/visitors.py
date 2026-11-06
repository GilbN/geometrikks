"""The client population: real public IPs, each resolved once to a real place and ASN.

The builder samples random addresses and keeps the ones the GeoLite2 City
database places, so every location is one MaxMind reports, never a random
coordinate. An IP keeps that location, ASN and user agent for the whole run,
which is what the IP inspector and the per-IP views expect.
"""

from __future__ import annotations

import ipaddress
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import geohash2
import geoip2.database
import geoip2.errors

from tests.seed.catalog import (
    BROWSER_USER_AGENTS,
    CRAWLERS,
    IPV6_POOLS,
    LAN_SUBNET,
    LAN_USER_AGENTS,
    SCANNER_USER_AGENTS,
    SITES,
    pick_weighted,
)
from tests.seed.config import SeedConfig

VisitorKind = Literal["browser", "crawler", "scanner", "lan"]

KIND_SHARES: tuple[tuple[VisitorKind, float], ...] = (("browser", 0.72), ("crawler", 0.04), ("scanner", 0.24))
IPV6_SHARE = 0.15
LAN_VISITORS = 12
# How often a cityless (country-level) record is kept. Live data has some, at
# the country's centroid, but most of it resolves to a city.
COUNTRY_ONLY_KEEP = 0.15


@dataclass(frozen=True, slots=True)
class Place:
    """One geo_locations row, keyed by geohash like ingestion keys it."""

    latitude: float
    longitude: float
    geohash: str
    country_code: str
    country_name: str
    state: str | None
    state_code: str | None
    city: str | None
    postal_code: str | None
    timezone: str | None


@dataclass(frozen=True, slots=True)
class Resolved:
    place: Place
    asn: int | None
    asn_org: str | None


class GeoSource(Protocol):
    def resolve(self, ip: str) -> Resolved | None: ...

    def is_hosting(self, asn: int | None) -> bool: ...


class MaxMindGeoSource:
    """Resolves IPs through the GeoLite2 City and ASN databases, as ingestion does."""

    def __init__(self, city_db: Path, asn_db: Path | None, locales: list[str]) -> None:
        from geometrikks.domain.analytics.asn_classification import hosting_asn_entries

        self._city = geoip2.database.Reader(str(city_db), locales=locales)
        self._asn = geoip2.database.Reader(str(asn_db)) if asn_db is not None else None
        self._hosting = frozenset(asn for asn, _ in hosting_asn_entries())

    def close(self) -> None:
        self._city.close()
        if self._asn is not None:
            self._asn.close()

    def resolve(self, ip: str) -> Resolved | None:
        try:
            record = self._city.city(ip)
        except (geoip2.errors.AddressNotFoundError, ValueError):
            return None
        latitude, longitude = record.location.latitude, record.location.longitude
        country_code, country_name = record.country.iso_code, record.country.name
        # Same acceptance rule as LogParser._parse_geo_data.
        if not latitude or not longitude or not country_code or not country_name:
            return None
        place = Place(
            latitude=latitude,
            longitude=longitude,
            geohash=geohash2.encode(latitude, longitude),
            country_code=country_code,
            country_name=country_name,
            state=record.subdivisions.most_specific.name,
            state_code=record.subdivisions.most_specific.iso_code,
            city=record.city.name,
            postal_code=record.postal.code,
            timezone=record.location.time_zone,
        )
        asn = org = None
        if self._asn is not None:
            try:
                asn_record = self._asn.asn(ip)
                asn, org = asn_record.autonomous_system_number, asn_record.autonomous_system_organization
            except (geoip2.errors.AddressNotFoundError, ValueError):
                pass
        return Resolved(place=place, asn=asn, asn_org=org)

    def is_hosting(self, asn: int | None) -> bool:
        return asn is not None and asn in self._hosting


@dataclass(frozen=True, slots=True)
class Visitor:
    """One client IP and everything that stays fixed about it."""

    ip: str
    kind: VisitorKind
    resolved: Resolved | None
    user_agent: str | None
    hosts: tuple[str, ...]
    active_from: float
    active_to: float
    utc_offset_hours: float


def _random_in(rng: random.Random, network: ipaddress.IPv4Network | ipaddress.IPv6Network) -> str:
    offset = rng.getrandbits(network.max_prefixlen - network.prefixlen)
    return str(network.network_address + offset)


def _random_public_ip(rng: random.Random) -> str:
    if rng.random() < IPV6_SHARE:
        return _random_in(rng, ipaddress.ip_network(rng.choice(IPV6_POOLS)))
    while True:
        address = ipaddress.IPv4Address(rng.getrandbits(32))
        if address.is_global and not address.is_multicast:
            return str(address)


def _utc_offset_hours(timezone_name: str | None, at: datetime) -> float:
    if not timezone_name:
        return 0.0
    try:
        offset = at.astimezone(ZoneInfo(timezone_name)).utcoffset()
    except (ZoneInfoNotFoundError, ValueError):
        return 0.0
    return offset.total_seconds() / 3600 if offset else 0.0


class VisitorBuilder:
    """Samples IPs until each visitor kind finds addresses that fit it."""

    MAX_ATTEMPTS = 400

    def __init__(self, config: SeedConfig, source: GeoSource, rng: random.Random) -> None:
        self.config = config
        self.source = source
        self.rng = rng
        self._start = config.start.timestamp()
        self._end = config.end.timestamp()
        self._seen: set[str] = set()
        # /16s already known to sit in the home country; sampling inside them
        # finds the next home IP far faster than the whole address space.
        self._home_subnets: list[ipaddress.IPv4Network] = []

    def build(self) -> list[Visitor]:
        visitors = [self._public_visitor(pick_weighted(self.rng, KIND_SHARES)) for _ in range(self.config.visitor_count)]
        lan = ipaddress.ip_network(LAN_SUBNET)
        lan_ips = self.rng.sample(range(10, 250), LAN_VISITORS)
        visitors.extend(
            Visitor(
                ip=str(lan.network_address + host),
                kind="lan",
                resolved=None,
                user_agent=pick_weighted(self.rng, LAN_USER_AGENTS),
                hosts=tuple(SITES),
                active_from=self._start,
                active_to=self._end,
                utc_offset_hours=0.0,
            )
            for host in lan_ips
        )
        return visitors

    def _public_visitor(self, kind: VisitorKind) -> Visitor:
        if kind == "crawler":
            _, user_agent, ranges = self.rng.choice(CRAWLERS)
            if ranges:
                ip, resolved = self._find(lambda r: True, ranges)
            else:
                ip, resolved = self._find(lambda r: self.source.is_hosting(r.asn))
        elif kind == "scanner":
            user_agent = pick_weighted(self.rng, SCANNER_USER_AGENTS)
            ip, resolved = self._find(lambda r: self.source.is_hosting(r.asn))
        else:
            user_agent = pick_weighted(self.rng, BROWSER_USER_AGENTS)
            home = self.config.home_country
            if home and self.rng.random() < self.config.home_share:
                ip, resolved = self._find_home(home.upper())
            else:
                ip, resolved = self._find(lambda r: not self.source.is_hosting(r.asn))

        active_from, active_to = self._window(kind)
        if kind == "browser":
            hosts = tuple(self.rng.sample(list(SITES), self.rng.randint(1, 3)))
        else:
            hosts = tuple(SITES)
        return Visitor(
            ip=ip,
            kind=kind,
            resolved=resolved,
            user_agent=user_agent,
            hosts=hosts,
            active_from=active_from,
            active_to=active_to,
            utc_offset_hours=_utc_offset_hours(resolved.place.timezone, self.config.end),
        )

    def _accept(self, ip: str, resolved: Resolved | None) -> bool:
        if resolved is None or ip in self._seen:
            return False
        return resolved.place.city is not None or self.rng.random() < COUNTRY_ONLY_KEEP

    def _find(
        self, fits: Callable[[Resolved], bool], ranges: tuple[str, ...] | None = None
    ) -> tuple[str, Resolved]:
        """A fresh IP whose record passes ``fits``; any resolvable one once attempts run out."""
        fallback: tuple[str, Resolved] | None = None
        for _ in range(self.MAX_ATTEMPTS):
            if ranges:
                ip = _random_in(self.rng, ipaddress.ip_network(self.rng.choice(ranges)))
            else:
                ip = _random_public_ip(self.rng)
            resolved = self.source.resolve(ip)
            if not self._accept(ip, resolved):
                continue
            assert resolved is not None
            if fits(resolved):
                self._seen.add(ip)
                return ip, resolved
            fallback = fallback or (ip, resolved)
        if fallback is None:
            if ranges:
                return self._find(fits)
            raise RuntimeError(
                "No sampled IP resolved to a location. Is the GeoLite2 City database a real build, "
                "not the test fixture?"
            )
        self._seen.add(fallback[0])
        return fallback

    def _find_home(self, country: str) -> tuple[str, Resolved]:
        for _ in range(self.MAX_ATTEMPTS * 25):
            if self._home_subnets and self.rng.random() < 0.5:
                ip = _random_in(self.rng, self.rng.choice(self._home_subnets))
            else:
                ip = str(ipaddress.IPv4Address(self.rng.getrandbits(32)))
                if not ipaddress.IPv4Address(ip).is_global:
                    continue
            resolved = self.source.resolve(ip)
            if not self._accept(ip, resolved):
                continue
            assert resolved is not None
            if resolved.place.country_code != country or self.source.is_hosting(resolved.asn):
                continue
            subnet = ipaddress.ip_network(f"{ip}/16", strict=False)
            if isinstance(subnet, ipaddress.IPv4Network) and subnet not in self._home_subnets:
                self._home_subnets.append(subnet)
            self._seen.add(ip)
            return ip, resolved
        raise RuntimeError(f"Found no IP in country {country!r}; check the ISO code")

    def _window(self, kind: VisitorKind) -> tuple[float, float]:
        """When this visitor is active: crawlers always, people for a stretch, scanners in a burst."""
        span = self._end - self._start
        if kind == "crawler":
            return self._start, self._end
        if kind == "scanner":
            length = min(span, self.rng.uniform(600, 6 * 3600))
            begin = self.rng.uniform(self._start, self._end - length)
            return begin, begin + length
        if self.rng.random() < 0.3:
            return self._start, self._end
        length = min(span, max(3600.0, self.rng.expovariate(4 / span)))
        begin = self.rng.uniform(self._start, self._end - length)
        return begin, begin + length
