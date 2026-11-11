"""Scanner visitors from documentation address space, the only addresses any DROP fixture lists.

Seed scanners are random addresses inside real hosting ASNs, so a DROP-listed
seed scanner would print a real provider's name next to Spamhaus's wording.
These seven visitors sit in RFC 5737 and RFC 3849 space under the RFC 5398
ASN, which no one owns. GeoLite2 places none of them, so they get no
geo_events row and no map marker, just as ingestion would store them.
"""

from __future__ import annotations

import ipaddress
import random
from datetime import UTC, datetime, timedelta
from typing import Final

import asyncpg

from tests.seed.catalog import SCANNER_USER_AGENTS, SITES, pick_weighted
from tests.seed.config import SeedConfig
from tests.seed.traffic import Batch, TrafficGenerator, debug_row_for
from tests.seed.visitors import Place, Resolved, Visitor
from tests.seed.writer import SeedWriter

DOCUMENTATION_NETWORKS: Final[tuple[str, ...]] = ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")
_DOCUMENTATION_V4: Final = tuple(ipaddress.IPv4Network(cidr) for cidr in DOCUMENTATION_NETWORKS if ":" not in cidr)
_DOCUMENTATION_V6: Final = tuple(ipaddress.IPv6Network(cidr) for cidr in DOCUMENTATION_NETWORKS if ":" in cidr)

DOC_ASN: Final = 64496
DOC_AS_NAME: Final = "Fictional Example Hosting"

DOC_VISITORS: Final[tuple[str, ...]] = (
    "203.0.113.10",
    "203.0.113.23",
    "203.0.113.77",
    "198.51.100.14",
    "198.51.100.200",
    "2001:db8:d0c::5",
    "2001:db8:d0c::9e",
)
DOC_DROP_NETWORKS: Final[tuple[str, ...]] = ("198.51.100.14/32", "203.0.113.0/24", "2001:db8:d0c::5/128")
DOC_INSPECT_IP: Final = "198.51.100.14"
DOC_BANS: Final[tuple[str, ...]] = ("198.51.100.14", "2001:db8:d0c::5")

# CensysInspect, l9scan and masscan name a real organization or person.
DOC_USER_AGENTS: Final[tuple[tuple[str | None, float], ...]] = tuple(
    (ua, weight) for ua, weight in SCANNER_USER_AGENTS if ua is None or "://" not in ua
)

UNPLACED: Final = Place(
    latitude=0.0,
    longitude=0.0,
    geohash="",
    country_code="",
    country_name="",
    state=None,
    state_code=None,
    city=None,
    postal_code=None,
    timezone=None,
)

WINDOW_START: Final = timedelta(days=6)
WINDOW_END: Final = timedelta(hours=2)
BURST_SECONDS: Final = (600, 3 * 3600)
BURST_REQUESTS: Final = (30, 90)


def is_documentation(value: str) -> bool:
    """Whether an address or network lies wholly inside one of the documentation ranges."""
    try:
        network = ipaddress.ip_network(value, strict=False)
    except ValueError:
        return False
    if isinstance(network, ipaddress.IPv4Network):
        return any(network.subnet_of(documentation) for documentation in _DOCUMENTATION_V4)
    return any(network.subnet_of(documentation) for documentation in _DOCUMENTATION_V6)


def doc_visitors(rng: random.Random) -> list[Visitor]:
    resolved = Resolved(place=UNPLACED, asn=DOC_ASN, asn_org=DOC_AS_NAME)
    return [
        Visitor(
            ip=ip,
            kind="scanner",
            resolved=resolved,
            user_agent=pick_weighted(rng, DOC_USER_AGENTS),
            hosts=tuple(SITES),
            active_from=0.0,
            active_to=0.0,
            utc_offset_hours=0.0,
        )
        for ip in DOC_VISITORS
    ]


def doc_traffic(config: SeedConfig, *, now: datetime, rng: random.Random) -> Batch:
    """One or two scanning bursts per documentation visitor between six days and two hours before ``now``."""
    visitors = doc_visitors(rng)
    generator = TrafficGenerator(config, visitors, {}, rng)
    earliest = int((now - WINDOW_START).timestamp()) + 1
    latest = int((now - WINDOW_END).timestamp())
    batch = Batch()
    for visitor in visitors:
        for _ in range(rng.randint(1, 2)):
            length = rng.randint(*BURST_SECONDS)
            begin = rng.randint(earliest, latest - length)
            for _ in range(rng.randint(*BURST_REQUESTS)):
                timestamp = datetime.fromtimestamp(rng.randint(begin, begin + length), tz=UTC)
                log, raw, parse_error = generator.line_at(visitor, timestamp)
                log = log._replace(country_code=None, country_name=None, city=None)
                if parse_error is not None or rng.random() < config.debug_share:
                    batch.linked.append((log, debug_row_for(log, raw, parse_error)))
                else:
                    batch.access_logs.append(log)
    return batch


async def write_doc_traffic(conn: asyncpg.Connection, config: SeedConfig, *, now: datetime, rng: random.Random) -> int:
    """Write the documentation visitors' rows and refresh the aggregates; return the access logs written.

    The seed already refreshed the per-IP aggregates, and real-time
    aggregation reads raw rows only past the watermark, so without this
    refresh the DROP card's aggregate leg would miss these rows.
    """
    writer = SeedWriter(conn)
    counts = await writer.write(doc_traffic(config, now=now, rng=rng))
    failed = await writer.refresh_aggregates()
    if failed:
        raise RuntimeError(f"aggregate refresh failed after the documentation visitors: {', '.join(failed)}")
    return counts.access_logs
