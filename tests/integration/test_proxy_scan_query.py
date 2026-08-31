"""The proxy-scan SQL against a real TimescaleDB access_logs table."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.system.proxy_scan import _query_scan_rows

NOW = datetime.now(timezone.utc)


async def _insert(session_maker, ts, ip, *, hostname, log_format="traefik-json", asn=None):
    async with session_maker() as session:
        session.add(AccessLog(
            timestamp=ts, ip_address=ip, method="GET", url="/", status_code=200,
            bytes_sent=0, hostname=hostname, log_format=log_format,
            autonomous_system_number=asn,
        ))
        await session.commit()


@pytest.mark.anyio
async def test_scan_queries_count_and_group(pg_session_maker, clean_tables) -> None:
    recent = NOW - timedelta(minutes=5)
    for _ in range(3):
        await _insert(pg_session_maker, recent, "104.16.1.1", hostname="traefik-01", asn=13335)
    await _insert(pg_session_maker, recent, "151.101.1.1", hostname="traefik-01", asn=54113)
    await _insert(pg_session_maker, recent, "8.8.8.8", hostname="traefik-01", asn=15169)
    await _insert(pg_session_maker, recent, "9.9.9.9", hostname="traefik-01", asn=None)
    # Outside the hour window: never counted.
    await _insert(pg_session_maker, NOW - timedelta(hours=2), "104.16.1.2",
                  hostname="traefik-01", asn=13335)
    # Excluded hostname: never returned.
    await _insert(pg_session_maker, recent, "104.16.1.3", hostname="web-01", asn=13335)
    # NULL hostname: never returned.
    await _insert(pg_session_maker, recent, "104.16.1.4", hostname=None, asn=13335)

    async with pg_session_maker() as session:
        groups, providers = await _query_scan_rows(session, {"web-01"})

    assert [(g.hostname, g.log_format, g.rows, g.cdn_rows) for g in groups] == [
        ("traefik-01", "traefik-json", 6, 4)
    ]
    by_asn = {(p.hostname, p.asn): p.hits for p in providers}
    assert by_asn == {("traefik-01", 13335): 3, ("traefik-01", 54113): 1}


@pytest.mark.anyio
async def test_scan_queries_empty_exclusion_set(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(minutes=5), "104.16.1.1",
                  hostname="traefik-01", asn=13335)
    async with pg_session_maker() as session:
        groups, providers = await _query_scan_rows(session, set())
    assert groups[0].hostname == "traefik-01"
    assert providers[0].asn == 13335
