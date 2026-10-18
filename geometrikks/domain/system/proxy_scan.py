"""Head-side CDN scan over access_logs for sources the head does not tail.

Same question as the parser's PeerWindow, answered from the database so
agent-tailed sources appear on the head's Status page. Private peers are
out of reach here: those lines are dropped before storage.

State is module-level like timescale._server_name_pollution: the scheduler job
writes it, /health reads it synchronously. A failed run keeps the last good
findings and records the error so /health can say the scan is broken rather
than silently dropping the cards.
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
    server: str
    log_format: str | None
    rows: int
    cdn_rows: int


@dataclass(frozen=True)
class ScanProvider:
    server: str
    asn: int
    hits: int


_findings: list[ProxyFinding] = []
_active: dict[str, bool] = {}
_last_error: str | None = None


def get_scan_findings() -> list[ProxyFinding]:
    """Findings from the last successful run; [] before it."""
    return list(_findings)


def get_scan_error() -> str | None:
    """Error text from the last run when it failed; None after a success."""
    return _last_error


def reset_scan_state() -> None:
    global _last_error
    _findings.clear()
    _active.clear()
    _last_error = None


def apply_scan_results(groups: list[ScanGroup], providers: list[ScanProvider]) -> None:
    """Fold one scan's rows into hysteresis state and rebuild the cache."""
    totals: dict[str, tuple[int, int]] = {}
    formats: dict[str, tuple[int, str | None]] = {}
    for group in groups:
        rows, cdn = totals.get(group.server, (0, 0))
        totals[group.server] = (rows + group.rows, cdn + group.cdn_rows)
        if group.rows > formats.get(group.server, (0, None))[0]:
            formats[group.server] = (group.rows, group.log_format)

    provider_hits: dict[str, dict[str, int]] = {}
    for provider in providers:
        provider_name = CDN_ASNS.get(provider.asn)
        if provider_name is None:
            continue
        hits_by_provider = provider_hits.setdefault(provider.server, {})
        hits_by_provider[provider_name] = hits_by_provider.get(provider_name, 0) + provider.hits

    findings: list[ProxyFinding] = []
    seen = set(totals)
    for server_name, (rows, cdn) in totals.items():
        share = cdn / rows if rows else 0.0
        active = _active.get(server_name, False)
        if not active and rows >= PEER_MIN_LINES and share >= PEER_SHARE_ON:
            _active[server_name] = active = True
            _log_transition("proxy_peer_detected", server_name, share, rows,
                            provider_hits, formats)
        elif active and share < PEER_SHARE_OFF:
            _active[server_name] = active = False
            _log_transition("proxy_peer_cleared", server_name, share, rows,
                            provider_hits, formats)
        if active:
            hits_by_provider = provider_hits.get(server_name, {})
            top = max(hits_by_provider, key=hits_by_provider.__getitem__) if hits_by_provider else None
            findings.append(ProxyFinding(
                server=server_name, path="", log_format=formats[server_name][1],
                kind="cdn", share=share, lines=rows, provider=top,
            ))

    vanished_servers = [
        server_name for server_name, is_active in _active.items()
        if is_active and server_name not in seen
    ]
    for server_name in vanished_servers:
        _active[server_name] = False
        _log_transition("proxy_peer_cleared", server_name, 0.0, 0, provider_hits, formats)

    _findings[:] = findings


def _log_transition(
    event: str,
    server_name: str,
    share: float,
    rows: int,
    provider_hits: dict[str, dict[str, int]],
    formats: dict[str, tuple[int, str | None]],
) -> None:
    hits_by_provider = provider_hits.get(server_name, {})
    logger.warning(
        event,
        server=server_name,
        kind="cdn",
        share=round(share, 3),
        lines=rows,
        provider=max(hits_by_provider, key=hits_by_provider.__getitem__) if hits_by_provider else None,
        log_format=formats.get(server_name, (0, None))[1],
        origin="db-scan",
    )


async def _query_scan_rows(
    session: "AsyncSession", exclude_servers: set[str]
) -> tuple[list[ScanGroup], list[ScanProvider]]:
    asns = list(CDN_ASNS)
    exclude = sorted(exclude_servers)

    groups_sql = (
        "SELECT server, log_format, COUNT(*) AS row_count, "
        "COUNT(*) FILTER (WHERE autonomous_system_number IN :asns) AS cdn_rows "
        f"FROM access_logs WHERE timestamp > now() - interval '{SCAN_WINDOW_MINUTES} minutes' "
        "AND server IS NOT NULL"
    )
    providers_sql = (
        "SELECT server, autonomous_system_number AS asn, COUNT(*) AS hits "
        f"FROM access_logs WHERE timestamp > now() - interval '{SCAN_WINDOW_MINUTES} minutes' "
        "AND server IS NOT NULL AND autonomous_system_number IN :asns"
    )
    if exclude:
        groups_sql += " AND server NOT IN :excluded"
        providers_sql += " AND server NOT IN :excluded"
    groups_sql += " GROUP BY server, log_format"
    providers_sql += " GROUP BY server, autonomous_system_number"

    params: dict[str, object] = {"asns": asns}
    if exclude:
        params["excluded"] = exclude

    stmt = text(groups_sql).bindparams(bindparam("asns", expanding=True))
    if exclude:
        stmt = stmt.bindparams(bindparam("excluded", expanding=True))
    result = await session.execute(stmt, params)
    groups = [
        ScanGroup(row.server, row.log_format, row.row_count, row.cdn_rows)
        for row in result
    ]

    stmt = text(providers_sql).bindparams(bindparam("asns", expanding=True))
    if exclude:
        stmt = stmt.bindparams(bindparam("excluded", expanding=True))
    result = await session.execute(stmt, params)
    providers = [ScanProvider(row.server, row.asn, row.hits) for row in result]
    return groups, providers


async def run_proxy_scan(
    session_factory: "Callable[[], AsyncSession]", exclude_servers: set[str]
) -> None:
    global _last_error
    try:
        async with session_factory() as session:
            groups, providers = await _query_scan_rows(session, exclude_servers)
    except Exception as exc:
        logger.warning("proxy_scan_failed", error=str(exc))
        _last_error = str(exc)
        return
    had_error = _last_error is not None
    previous_error = _last_error
    _last_error = None
    if had_error:
        logger.info("proxy_scan_recovered", previous_error=previous_error)
    apply_scan_results(groups, providers)
