"""DROP fixture lists, imported in-process through the app's own refresh code.

``geometrikks/domain/drop/feeds.py`` hard-codes the Spamhaus URLs, so the run
hands ``refresh_drop_lists`` a mock transport that answers those URLs from
fixture bodies. Nothing reaches Spamhaus. The import stamps every feed as
checked now, so the app's startup refresh skips them all.
"""

from __future__ import annotations

import ipaddress
import json
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Final

import asyncpg
import httpx2
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.drop.feeds import FEED_URLS, DropFeed
from geometrikks.domain.drop.refresh import FEEDS, FeedOutcome, refresh_drop_lists
from tests.screenshots.doc_traffic import (
    DOC_AS_NAME,
    DOC_ASN,
    HOME_AS_NAME,
    HOME_ASN,
    is_documentation,
    overlaps_home_network,
)

FIXTURE_COPYRIGHT: Final = "GeoMetrikks screenshot fixture, not Spamhaus data"
# Documentation space no visitor uses, so the filler records match no traffic.
# 192.0.2.64/26 stays clear of the capture browser's 192.0.2.10 and of the
# AS64497 home range 192.0.2.128/25.
FILLER_V4_NETWORK: Final = "192.0.2.64/26"
FILLER_V6_NETWORK: Final = "2001:db8:ffff::/48"


def _ndjson(records: Sequence[dict[str, object]], *, now: datetime) -> bytes:
    metadata = {
        "type": "metadata",
        "timestamp": int(now.timestamp()),
        "records": len(records),
        "copyright": FIXTURE_COPYRIGHT,
    }
    return "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in [*records, metadata]).encode()


def feed_bodies(drop_networks: Sequence[str], *, now: datetime) -> dict[DropFeed, bytes]:
    """The three feeds as Spamhaus serves them, listing only documentation space and AS64496.

    ASN-DROP never lists a seed ASN: that would show a real company as DROP-listed.
    No network touches the AS64497 home ranges, whose visitors top the Overview.
    """
    for network in drop_networks:
        if not is_documentation(network):
            raise ValueError(f"{network} is outside the documentation ranges; a DROP fixture may list only those")
        if overlaps_home_network(network):
            raise ValueError(f"{network} overlaps the AS{HOME_ASN} {HOME_AS_NAME} home ranges, which no DROP list may touch")
    v4 = [network for network in drop_networks if ipaddress.ip_network(network).version == 4] + [FILLER_V4_NETWORK]
    v6 = [network for network in drop_networks if ipaddress.ip_network(network).version == 6] + [FILLER_V6_NETWORK]
    sbl_ids = (f"SBLDEMO{number:02d}" for number in range(1, len(v4) + len(v6) + 1))
    return {
        "v4": _ndjson([{"cidr": cidr, "sblid": next(sbl_ids)} for cidr in v4], now=now),
        "v6": _ndjson([{"cidr": cidr, "sblid": next(sbl_ids)} for cidr in v6], now=now),
        "asn": _ndjson([{"asn": DOC_ASN, "asname": DOC_AS_NAME}], now=now),
    }


def fixture_transport(bodies: Mapping[DropFeed, bytes]) -> httpx2.MockTransport:
    """Answers each feed URL with its fixture body and anything else with a 404."""
    by_url = {FEED_URLS[feed]: body for feed, body in bodies.items()}

    def answer(request: httpx2.Request) -> httpx2.Response:
        body = by_url.get(str(request.url))
        if request.method != "GET" or body is None:
            return httpx2.Response(404)
        return httpx2.Response(200, content=body)

    return httpx2.MockTransport(answer)


async def import_fixture_lists(
    session_factory: Callable[[], AsyncSession], bodies: Mapping[DropFeed, bytes], *, now: datetime
) -> list[FeedOutcome]:
    outcomes = await refresh_drop_lists(session_factory, now=now, transport=fixture_transport(bodies))
    if [outcome.status for outcome in outcomes] != ["imported"] * len(FEEDS):
        summary = ", ".join(f"{outcome.feed} {outcome.status} ({outcome.reason})" for outcome in outcomes)
        raise RuntimeError(f"the DROP fixture import did not import every feed: {summary}")
    return outcomes


async def drop_marker_intact(conn: asyncpg.Connection) -> bool:
    """Whether every feed still holds the fixture import and nothing has tried a real download since.

    The refresh commits ``checked_at`` before each request, so a failed real
    download leaves the copyright as it was but moves ``checked_at`` past
    ``fetched_at`` and sets ``last_error``.
    """
    rows = await conn.fetch("SELECT feed, copyright, last_error, checked_at, fetched_at FROM drop_list_state")
    return {row["feed"] for row in rows} == set(FEEDS) and all(
        row["copyright"] == FIXTURE_COPYRIGHT
        and row["last_error"] is None
        and row["checked_at"] is not None
        and row["checked_at"] == row["fetched_at"]
        for row in rows
    )


async def documentation_only_drop_lists(conn: asyncpg.Connection) -> list[str]:
    """Every DROP network outside documentation space or over the AS64497 home ranges, and every
    listed ASN but AS64496; empty means clean."""
    networks = await conn.fetch("SELECT cidr::text AS cidr FROM drop_networks ORDER BY cidr")
    asns = await conn.fetch("SELECT asn FROM drop_asns ORDER BY asn")
    return [
        row["cidr"]
        for row in networks
        if not is_documentation(row["cidr"]) or overlaps_home_network(row["cidr"])
    ] + [f"AS{row['asn']}" for row in asns if row["asn"] != DOC_ASN]
