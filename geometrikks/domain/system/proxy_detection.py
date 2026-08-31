"""Turn parser peer windows into Settings > Status advisories.

Pure functions; /health calls them per request, so no I/O and no state.
Advisory is imported lazily: controllers.health imports this module.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Literal

if TYPE_CHECKING:
    from geometrikks.domain.system.controllers.health import Advisory

PROXY_SETUP_DOCS_URL = "https://github.com/GilbN/geometrikks/blob/main/docs/proxy-setup.md"

_TRAEFIK_REMEDY = "entryPoints.<name>.forwardedHeaders.trustedIPs"
_CADDY_REMEDY = "servers.trusted_proxies"
_NGINX_CDN_REMEDY = "set_real_ip_from <cdn ranges>; real_ip_header CF-Connecting-IP;"
_NGINX_PRIVATE_REMEDY = "set_real_ip_from <proxy address>; real_ip_header X-Forwarded-For;"


@dataclass(frozen=True)
class ProxyFinding:
    hostname: str
    path: str
    log_format: str | None
    kind: Literal["cdn", "private"]
    share: float
    lines: int
    provider: str | None


def proxy_findings(parsers: Iterable[Any]) -> list[ProxyFinding]:
    findings: list[ProxyFinding] = []
    for parser in parsers:
        summary = parser.peer_summary()
        if summary is None:
            continue
        fmt = parser.format.name if parser.format else None
        hostname = parser.hostname
        path = str(parser.log_path)
        lines = summary.lines

        if summary.cdn_active:
            findings.append(ProxyFinding(
                hostname=hostname,
                path=path,
                log_format=fmt,
                kind="cdn",
                share=summary.cdn_share,
                lines=lines,
                provider=summary.top_provider,
            ))
        if summary.private_active:
            findings.append(ProxyFinding(
                hostname=hostname,
                path=path,
                log_format=fmt,
                kind="private",
                share=summary.private_share,
                lines=lines,
                provider=None,
            ))
    return findings


def _pct(share: float) -> str:
    return f"{round(share * 100)}%"


def _remedy(findings: list[ProxyFinding], nginx_remedy: str) -> str:
    formats = {f.log_format for f in findings}
    parts: list[str] = []
    # Formats without their own arm, including None, take the nginx remedy.
    if formats - {"traefik-json", "caddy-json"}:
        parts.append(nginx_remedy)
    if "traefik-json" in formats:
        parts.append(_TRAEFIK_REMEDY)
    if "caddy-json" in formats:
        parts.append(_CADDY_REMEDY)
    return " ".join(parts)


def _cdn_card(findings: list[ProxyFinding], docs_url: str) -> "Advisory":
    from geometrikks.domain.system.controllers.health import Advisory

    if len(findings) == 1:
        f = findings[0]
        summary = (
            f"{_pct(f.share)} of the last {f.lines:,} requests for {f.hostname} "
            f"came from {f.provider or 'CDN'} addresses. The map shows "
            f"{f.provider or 'the CDN'}'s datacenters, not your visitors."
        )
    else:
        listed = ", ".join(
            f"{f.hostname} ({_pct(f.share)} {f.provider or 'CDN'})" for f in findings
        )
        summary = (
            f"Most recent requests for {listed} came from CDN addresses. "
            "The map shows their datacenters, not your visitors."
        )
    return Advisory(
        id="proxy-peer-cdn",
        severity="warning",
        summary=summary,
        detail=(
            "Your proxy logs the connecting peer, which is the CDN edge, not "
            "the client. GeoIP, ASN, Top countries, the IP inspector and "
            "CrowdSec decisions all key on that address. Rows already "
            "ingested keep it."
        ),
        remedy=_remedy(findings, _NGINX_CDN_REMEDY),
        docs_url=docs_url,
    )


def _private_card(findings: list[ProxyFinding], docs_url: str) -> "Advisory":
    from geometrikks.domain.system.controllers.health import Advisory

    if len(findings) == 1:
        f = findings[0]
        summary = (
            f"{_pct(f.share)} of the last {f.lines:,} requests for {f.hostname} "
            "came from private addresses. They get no location, so they never "
            "reach the map or Access logs."
        )
    else:
        listed = ", ".join(f"{f.hostname} ({_pct(f.share)})" for f in findings)
        summary = (
            f"Most recent requests for {listed} came from private addresses. "
            "They get no location, so they never reach the map or Access logs."
        )
    return Advisory(
        id="proxy-peer-private",
        severity="warning",
        summary=summary,
        detail=(
            "A tunnel (cloudflared), a proxy in front of your proxy on the "
            "same Docker network, or Tailscale-only access puts a private "
            "address in the log. For a tunnel or a proxy chain, configure "
            "real-IP resolution so the visitor's address is logged. For "
            "Tailscale-only access this is expected; set "
            "APP_PROXY_ADVISORY=false to hide this card."
        ),
        remedy=_remedy(findings, _NGINX_PRIVATE_REMEDY),
        docs_url=docs_url,
    )


def proxy_advisories(
    findings: list[ProxyFinding], *, docs_url: str = PROXY_SETUP_DOCS_URL
) -> "list[Advisory]":
    cards: list[Advisory] = []
    cdn = [f for f in findings if f.kind == "cdn"]
    private = [f for f in findings if f.kind == "private"]
    if cdn:
        cards.append(_cdn_card(cdn, docs_url))
    if private:
        cards.append(_private_card(private, docs_url))
    return cards
