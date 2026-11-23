"""Muted IPs fixture: the saved list the muted-ips scene shows.

The Muted IPs switch starts on in every browser, so once the list holds
entries, every Access Logs, Geo Logs and Analytics scene hides what it covers
and shows the switch. No entry may cover a stored request, so those scenes
keep the rows they had before the list existed and gain only the switch.
"""

from __future__ import annotations

import ipaddress
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

import asyncpg

from geometrikks.domain.muted_ips.networks import with_mapped_twins
from tests.screenshots.doc_traffic import is_documentation


@dataclass(frozen=True, slots=True)
class MutedEntry:
    network: str
    note: str
    age: timedelta


# 192.0.2.10 is the address the capture browser sends in X-Forwarded-For.
MUTED_ENTRIES: Final[tuple[MutedEntry, ...]] = (
    MutedEntry(
        network="192.0.2.10/32", note="This laptop", age=timedelta(days=12, hours=3)
    ),
    MutedEntry(
        network="198.51.100.32/28",
        note="Uptime monitor",
        age=timedelta(days=4, hours=6),
    ),
    MutedEntry(
        network="2001:db8:cafe::/48", note="Home network", age=timedelta(hours=5)
    ),
)

INSERT_SQL: Final = "INSERT INTO muted_ips (id, network, note, created_at) VALUES ($1, $2::cidr, $3, $4)"

COVERED_SQL: Final = """
SELECT DISTINCT host(ip_address) AS ip FROM (
    SELECT ip_address FROM access_logs WHERE ip_address <<= ANY($1::cidr[])
    UNION ALL
    SELECT ip_address FROM geo_events WHERE ip_address <<= ANY($1::cidr[])
) AS covered
ORDER BY ip
LIMIT 10
"""


def entry_problems(entries: tuple[MutedEntry, ...] = MUTED_ENTRIES) -> list[str]:
    """What the app would refuse in the list, or what would put a real address in a shot."""
    problems = []
    if len(entries) > 20:
        problems.append(f"{len(entries)} entries, over the app's limit of 20")
    for entry in entries:
        try:
            ipaddress.ip_network(entry.network, strict=True)
        except ValueError:
            problems.append(f"{entry.network} is not a network address")
            continue
        if not is_documentation(entry.network):
            problems.append(f"{entry.network} lies outside the documentation ranges")
        if len(entry.note) > 100:
            problems.append(f"the note for {entry.network} is over 100 characters")
    return problems


async def write_fixture_mutes(conn: asyncpg.Connection, *, now: datetime) -> int:
    problems = entry_problems()
    if problems:
        raise ValueError(f"Muted IPs fixture: {'; '.join(problems)}")
    await conn.executemany(
        INSERT_SQL,
        [
            (
                uuid.uuid4(),
                ipaddress.ip_network(entry.network),
                entry.note,
                now - entry.age,
            )
            for entry in MUTED_ENTRIES
        ],
    )
    return len(MUTED_ENTRIES)


async def muted_request_ips(conn: asyncpg.Connection) -> list[str]:
    """Stored request addresses the list covers, IPv4-mapped forms included; none may exist."""
    networks = with_mapped_twins(
        ipaddress.ip_network(entry.network) for entry in MUTED_ENTRIES
    )
    rows = await conn.fetch(COVERED_SQL, networks)
    return [row["ip"] for row in rows]
