"""Which IPs the screenshots ban, inspect and list, picked from the seeded database.

Seed IPs follow the GeoLite2 build, so nothing here names one. Seed picks
are ranked by traffic in the last 7 days, the range every shot stores, so
the banned IPs show up in the shots. Everything DROP-related comes from the
documentation visitors only.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final

import asyncpg

from tests.screenshots.doc_traffic import (
    DOC_AS_NAME,
    DOC_ASN,
    DOC_BANS,
    DOC_DROP_NETWORKS,
    DOC_INSPECT_IP,
    DOC_VISITORS,
)
from tests.seed.catalog import CRAWLER_PATHS, SCANNER_REQUESTS, SITES

# Browsers also fetch /favicon.ico and crawlers /robots.txt, so a path any of
# them requests would rank busy browsers and real crawler ranges as scanners.
_ORDINARY_PATHS: Final = frozenset(
    {path for pages in SITES.values() for path, _ in pages} | {path for path, _ in CRAWLER_PATHS}
)
PROBE_PATHS: Final[frozenset[str]] = frozenset(
    path for _, path, _ in SCANNER_REQUESTS if path != "/" and path not in _ORDINARY_PATHS
)

SCANNERS_NEEDED: Final = 22
ACTIVE_BANS: Final = slice(0, 10)
EXPIRED_BANS: Final = slice(10, 16)
DETECTIONS: Final = slice(16, 20)
CAPTCHA_RANK: Final = 20
RANGE_BAN_FROM_RANK: Final = 21


@dataclass(frozen=True, slots=True)
class IpStats:
    ip: str
    requests: int
    recent_requests: int
    probe_hits: int
    country_code: str | None
    city: str | None
    asn: int | None
    asn_org: str | None
    location_id: int | None
    latitude: float | None
    longitude: float | None


@dataclass(frozen=True, slots=True)
class FixtureIps:
    active_bans: tuple[str, ...]
    expired_bans: tuple[str, ...]
    detections: tuple[str, ...]
    captcha: str
    range_ban: str
    drop_bans: tuple[str, ...]
    drop_networks: tuple[str, ...]
    inspect_ip: str
    focus_location: int

    def all_ips(self) -> frozenset[str]:
        return frozenset(
            (*self.active_bans, *self.expired_bans, *self.detections, self.captcha, *self.drop_bans, self.inspect_ip)
        )


class FixtureError(RuntimeError):
    """The seeded database cannot supply the fixtures; the message says what to change."""


# An IP whose rows disagree on the ASN or organization reports NULL, which
# the documentation-visitor check then refuses.
IP_STATS_SQL: Final = """
WITH per_ip AS (
    SELECT
        ip_address,
        count(*) AS requests,
        count(*) FILTER (WHERE timestamp >= $2) AS recent_requests,
        count(*) FILTER (WHERE url = ANY($1::text[])) AS probe_hits,
        max(country_code) AS country_code,
        CASE WHEN count(autonomous_system_number) = count(*)
              AND min(autonomous_system_number) = max(autonomous_system_number)
             THEN min(autonomous_system_number) END AS asn,
        CASE WHEN count(autonomous_system_organization) = count(*)
              AND min(autonomous_system_organization) = max(autonomous_system_organization)
             THEN min(autonomous_system_organization) END AS asn_org
    FROM access_logs
    GROUP BY ip_address
),
latest_location AS (
    SELECT DISTINCT ON (ip_address) ip_address, location_id
    FROM geo_events
    ORDER BY ip_address, timestamp DESC
)
SELECT
    host(per_ip.ip_address) AS ip,
    per_ip.requests,
    per_ip.recent_requests,
    per_ip.probe_hits,
    per_ip.country_code,
    geo_locations.city,
    per_ip.asn,
    per_ip.asn_org,
    geo_locations.id AS location_id,
    geo_locations.latitude,
    geo_locations.longitude
FROM per_ip
LEFT JOIN latest_location ON latest_location.ip_address = per_ip.ip_address
LEFT JOIN geo_locations ON geo_locations.id = latest_location.location_id
ORDER BY per_ip.ip_address
"""


async def load_ip_stats(conn: asyncpg.Connection, *, since: datetime) -> list[IpStats]:
    rows = await conn.fetch(IP_STATS_SQL, sorted(PROBE_PATHS), since)
    return [
        IpStats(
            ip=row["ip"],
            requests=row["requests"],
            recent_requests=row["recent_requests"],
            probe_hits=row["probe_hits"],
            country_code=row["country_code"],
            city=row["city"],
            asn=row["asn"],
            asn_org=row["asn_org"],
            location_id=row["location_id"],
            latitude=row["latitude"],
            longitude=row["longitude"],
        )
        for row in rows
    ]


def _check_documentation_visitors(documentation: dict[str, IpStats]) -> None:
    quiet = [ip for ip in DOC_VISITORS if ip not in documentation or documentation[ip].recent_requests <= 0]
    if quiet:
        raise FixtureError(
            f"documentation visitors with no traffic in the last 7 days: {', '.join(quiet)}; "
            "write_doc_traffic must run before load_ip_stats"
        )
    expected: dict[str, object] = {
        "country_code": None,
        "city": None,
        "location_id": None,
        "latitude": None,
        "longitude": None,
        "asn": DOC_ASN,
        "asn_org": DOC_AS_NAME,
    }
    for ip in DOC_VISITORS:
        for field, want in expected.items():
            value = getattr(documentation[ip], field)
            if value != want:
                raise FixtureError(
                    f"documentation visitor {ip} has {field} {value!r}; "
                    f"its rows must carry only AS{DOC_ASN} {DOC_AS_NAME}"
                )


def _pick_focus_location(seed: Sequence[IpStats]) -> int:
    # A visitor GeoLite2 places only by country sits on the country centroid,
    # which zooms the map shot onto empty land.
    scanner_locations = {entry.location_id for entry in seed if entry.probe_hits > 0}
    traffic: dict[int, int] = {}
    for entry in seed:
        if (
            entry.probe_hits == 0
            and entry.recent_requests > 0
            and entry.location_id is not None
            and entry.city
            and entry.city.strip()
            and entry.location_id not in scanner_locations
        ):
            traffic[entry.location_id] = traffic.get(entry.location_id, 0) + entry.recent_requests
    if not traffic:
        raise FixtureError(
            "no city-level location without scanners has visitor traffic in the last 7 days; raise --rows"
        )
    return min(traffic, key=lambda location_id: (-traffic[location_id], location_id))


def pick_fixture_ips(stats: Sequence[IpStats]) -> FixtureIps:
    documentation = {entry.ip: entry for entry in stats if entry.ip in DOC_VISITORS}
    seed = [entry for entry in stats if entry.ip not in DOC_VISITORS]

    scanners = sorted(
        (entry for entry in seed if entry.probe_hits > 0 and entry.recent_requests > 0),
        key=lambda entry: (-entry.recent_requests, entry.ip),
    )
    if len(scanners) < SCANNERS_NEEDED:
        raise FixtureError(
            f"the seed produced {len(scanners)} scanners; {SCANNERS_NEEDED} are needed, raise --rows"
        )
    range_source = next(
        (entry for entry in scanners[RANGE_BAN_FROM_RANK:] if ipaddress.ip_address(entry.ip).version == 4), None
    )
    if range_source is None:
        raise FixtureError(f"no IPv4 scanner from rank {RANGE_BAN_FROM_RANK} on for the range ban; raise --rows")

    focus_location = _pick_focus_location(seed)

    _check_documentation_visitors(documentation)

    ranked = [entry.ip for entry in scanners]
    return FixtureIps(
        active_bans=tuple(ranked[ACTIVE_BANS]),
        expired_bans=tuple(ranked[EXPIRED_BANS]),
        detections=tuple(ranked[DETECTIONS]),
        captcha=ranked[CAPTCHA_RANK],
        range_ban=str(ipaddress.ip_network(f"{range_source.ip}/24", strict=False)),
        drop_bans=DOC_BANS,
        drop_networks=DOC_DROP_NETWORKS,
        inspect_ip=DOC_INSPECT_IP,
        focus_location=focus_location,
    )
