"""Head-side CDN scan over access_logs for sources the head does not tail.

Same question as the parser's PeerWindow, answered from the database so
agent-tailed sources appear on the head's Status page. Private peers are
out of reach here: those lines are dropped before storage.

State is module-level like timescale._hostname_pollution: the scheduler
job writes it, /health reads it synchronously. A failed run clears both
cache and hysteresis state so a down database drops the cards within one
job interval instead of serving stale ones; the re-detect log line after
an outage is the accepted cost.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import structlog
from sqlalchemy import bindparam, text

from geometrikks.domain.analytics.cdn_asns import CDN_ASNS
from geometrikks.domain.system.proxy_detection import ProxyFinding
from geometrikks.services.logparser.peer_window import (
    PEER_MIN_LINES,
    PEER_SHARE_OFF,
    PEER_SHARE_ON,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

SCAN_WINDOW_MINUTES = 60


@dataclass(frozen=True)
class ScanGroup:
    hostname: str
    log_format: str | None
    rows: int
    cdn_rows: int


@dataclass(frozen=True)
class ScanProvider:
    hostname: str
    asn: int
    hits: int


_findings: list[ProxyFinding] = []
_active: dict[str, bool] = {}


def get_scan_findings() -> list[ProxyFinding]:
    """Findings from the last successful run; [] before it or after a failure."""
    return list(_findings)


def reset_scan_state() -> None:
    _findings.clear()
    _active.clear()


def apply_scan_results(groups: list[ScanGroup], providers: list[ScanProvider]) -> None:
    """Fold one scan's rows into hysteresis state and rebuild the cache."""
    totals: dict[str, tuple[int, int]] = {}
    formats: dict[str, tuple[int, str | None]] = {}
    for g in groups:
        rows, cdn = totals.get(g.hostname, (0, 0))
        totals[g.hostname] = (rows + g.rows, cdn + g.cdn_rows)
        if g.rows > formats.get(g.hostname, (0, None))[0]:
            formats[g.hostname] = (g.rows, g.log_format)

    provider_hits: dict[str, dict[str, int]] = {}
    for p in providers:
        name = CDN_ASNS.get(p.asn)
        if name is None:
            continue
        by_name = provider_hits.setdefault(p.hostname, {})
        by_name[name] = by_name.get(name, 0) + p.hits

    findings: list[ProxyFinding] = []
    seen = set(totals)
    for hostname, (rows, cdn) in totals.items():
        share = cdn / rows if rows else 0.0
        active = _active.get(hostname, False)
        if not active and rows >= PEER_MIN_LINES and share >= PEER_SHARE_ON:
            _active[hostname] = active = True
            _log_transition("proxy_peer_detected", hostname, share, rows,
                            provider_hits, formats)
        elif active and share < PEER_SHARE_OFF:
            _active[hostname] = active = False
            _log_transition("proxy_peer_cleared", hostname, share, rows,
                            provider_hits, formats)
        if active:
            by_name = provider_hits.get(hostname, {})
            top = max(by_name, key=by_name.__getitem__) if by_name else None
            findings.append(ProxyFinding(
                hostname=hostname, path="", log_format=formats[hostname][1],
                kind="cdn", share=share, lines=rows, provider=top,
            ))

    for hostname in [h for h, on in _active.items() if on and h not in seen]:
        _active[hostname] = False
        _log_transition("proxy_peer_cleared", hostname, 0.0, 0, provider_hits, formats)

    _findings[:] = findings


def _log_transition(
    event: str,
    hostname: str,
    share: float,
    rows: int,
    provider_hits: dict[str, dict[str, int]],
    formats: dict[str, tuple[int, str | None]],
) -> None:
    by_name = provider_hits.get(hostname, {})
    logger.warning(
        event,
        hostname=hostname,
        kind="cdn",
        share=round(share, 3),
        lines=rows,
        provider=max(by_name, key=by_name.__getitem__) if by_name else None,
        log_format=formats.get(hostname, (0, None))[1],
        origin="db-scan",
    )


async def _query_scan_rows(
    session: "AsyncSession", exclude_hostnames: set[str]
) -> tuple[list[ScanGroup], list[ScanProvider]]:
    asns = list(CDN_ASNS)
    exclude = sorted(exclude_hostnames)

    groups_sql = (
        "SELECT hostname, log_format, COUNT(*) AS row_count, "
        "COUNT(*) FILTER (WHERE autonomous_system_number IN :asns) AS cdn_rows "
        f"FROM access_logs WHERE timestamp > now() - interval '{SCAN_WINDOW_MINUTES} minutes' "
        "AND hostname IS NOT NULL"
    )
    providers_sql = (
        "SELECT hostname, autonomous_system_number AS asn, COUNT(*) AS hits "
        f"FROM access_logs WHERE timestamp > now() - interval '{SCAN_WINDOW_MINUTES} minutes' "
        "AND hostname IS NOT NULL AND autonomous_system_number IN :asns"
    )
    if exclude:
        groups_sql += " AND hostname NOT IN :excluded"
        providers_sql += " AND hostname NOT IN :excluded"
    groups_sql += " GROUP BY hostname, log_format"
    providers_sql += " GROUP BY hostname, autonomous_system_number"

    params: dict[str, object] = {"asns": asns}
    if exclude:
        params["excluded"] = exclude

    stmt = text(groups_sql).bindparams(bindparam("asns", expanding=True))
    if exclude:
        stmt = stmt.bindparams(bindparam("excluded", expanding=True))
    result = await session.execute(stmt, params)
    groups = [
        ScanGroup(row.hostname, row.log_format, row.row_count, row.cdn_rows)
        for row in result
    ]

    stmt = text(providers_sql).bindparams(bindparam("asns", expanding=True))
    if exclude:
        stmt = stmt.bindparams(bindparam("excluded", expanding=True))
    result = await session.execute(stmt, params)
    providers = [ScanProvider(row.hostname, row.asn, row.hits) for row in result]
    return groups, providers


async def run_proxy_scan(
    session_factory: "Callable[[], AsyncSession]", exclude_hostnames: set[str]
) -> None:
    try:
        async with session_factory() as session:
            groups, providers = await _query_scan_rows(session, exclude_hostnames)
    except Exception as exc:
        logger.warning("proxy_scan_failed", error=str(exc))
        reset_scan_state()
        return
    apply_scan_results(groups, providers)
