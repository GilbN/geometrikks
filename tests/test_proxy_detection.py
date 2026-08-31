"""Findings from parser windows, and the advisory cards built from them."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from geometrikks.domain.system.proxy_detection import (
    PROXY_SETUP_DOCS_URL, ProxyFinding, proxy_advisories, proxy_findings,
)
from geometrikks.services.logparser.peer_window import PeerSummary


def fake_parser(*, hostname="web-01", fmt="nginx", summary=None):
    return SimpleNamespace(
        hostname=hostname,
        log_path=Path(f"/logs/{hostname}.log"),
        format=SimpleNamespace(name=fmt) if fmt else None,
        peer_summary=lambda: summary,
    )


def summary(
    *,
    lines: int = 1000,
    cdn_share: float = 0.0,
    private_share: float = 0.0,
    top_provider: str | None = None,
    cdn_active: bool = False,
    private_active: bool = False,
) -> PeerSummary:
    return PeerSummary(
        lines=lines,
        cdn_share=cdn_share,
        private_share=private_share,
        top_provider=top_provider,
        cdn_active=cdn_active,
        private_active=private_active,
    )


def test_findings_skip_inactive_and_none() -> None:
    parsers = [
        fake_parser(summary=None),                       # window off
        fake_parser(summary=summary()),                  # nothing active
    ]
    assert proxy_findings(parsers) == []


def test_findings_one_per_active_kind() -> None:
    s = summary(cdn_share=0.94, cdn_active=True, top_provider="Cloudflare",
                private_share=0.8, private_active=True)
    [cdn, private] = proxy_findings([fake_parser(summary=s)])
    assert cdn.kind == "cdn" and cdn.provider == "Cloudflare" and cdn.share == 0.94
    assert private.kind == "private" and private.provider is None
    assert cdn.hostname == "web-01" and cdn.log_format == "nginx"


def test_cdn_card_single_source() -> None:
    finding = ProxyFinding("web-01", "/logs/a.log", "nginx", "cdn", 0.94, 2000, "Cloudflare")
    [card] = proxy_advisories([finding])
    assert card.id == "proxy-peer-cdn"
    assert card.severity == "warning"
    assert "94%" in card.summary and "Cloudflare" in card.summary and "web-01" in card.summary
    assert card.remedy is not None and "set_real_ip_from" in card.remedy
    assert card.docs_url == PROXY_SETUP_DOCS_URL


def test_private_card_names_the_off_switch() -> None:
    finding = ProxyFinding("web-01", "/logs/a.log", "traefik-json", "private", 0.97, 2000, None)
    [card] = proxy_advisories([finding])
    assert card.id == "proxy-peer-private"
    assert card.detail is not None and "APP_PROXY_ADVISORY=false" in card.detail
    assert card.remedy is not None and "forwardedHeaders.trustedIPs" in card.remedy


def test_cdn_card_caddy_remedy() -> None:
    finding = ProxyFinding("web-01", "/logs/a.log", "caddy-json", "cdn", 0.9, 2000, "Cloudflare")
    [card] = proxy_advisories([finding])
    assert card.remedy is not None and "servers.trusted_proxies" in card.remedy


def test_cdn_card_mixed_nginx_and_caddy_remedy() -> None:
    findings = [
        ProxyFinding("web-01", "/l/a", "nginx", "cdn", 0.94, 2000, "Cloudflare"),
        ProxyFinding("web-02", "/l/b", "caddy-json", "cdn", 0.81, 2000, "Fastly"),
    ]
    [card] = proxy_advisories(findings)
    assert (card.remedy is not None
            and "set_real_ip_from" in card.remedy
            and "servers.trusted_proxies" in card.remedy)


def test_two_kinds_two_cards_multiple_sources() -> None:
    findings = [
        ProxyFinding("web-01", "/l/a", "nginx", "cdn", 0.94, 2000, "Cloudflare"),
        ProxyFinding("web-02", "/l/b", "traefik-json", "cdn", 0.81, 2000, "Fastly"),
        ProxyFinding("web-03", "/l/c", "nginx", "private", 0.99, 2000, None),
    ]
    cards = proxy_advisories(findings)
    assert [c.id for c in cards] == ["proxy-peer-cdn", "proxy-peer-private"]
    cdn = cards[0]
    assert "web-01" in cdn.summary and "web-02" in cdn.summary
    assert "94% Cloudflare" in cdn.summary and "81% Fastly" in cdn.summary
    # Mixed formats: both remedies present.
    assert (cdn.remedy is not None
            and "set_real_ip_from" in cdn.remedy
            and "forwardedHeaders.trustedIPs" in cdn.remedy)


def test_collect_advisories_includes_proxy_cards(monkeypatch) -> None:
    from types import SimpleNamespace
    from geometrikks.domain.system.controllers import health
    from geometrikks.server import runtime, timescale

    s = summary(private_share=0.9, private_active=True)
    service = SimpleNamespace(parsers=[fake_parser(summary=s)])
    monkeypatch.setattr(runtime, "get_ingestion_service", lambda app: service)
    monkeypatch.setattr(timescale, "get_hostname_pollution", lambda: None)

    settings = SimpleNamespace(
        app=SimpleNamespace(proxy_advisory=True),
        geoip=SimpleNamespace(asn_enabled=False),
    )
    cards = health._collect_advisories(app=cast(Any, object()), settings=cast(Any, settings))
    assert [c.id for c in cards] == ["proxy-peer-private"]


def test_collect_advisories_respects_off_switch(monkeypatch) -> None:
    from types import SimpleNamespace
    from geometrikks.domain.system.controllers import health
    from geometrikks.server import runtime, timescale

    monkeypatch.setattr(
        runtime, "get_ingestion_service",
        lambda app: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    monkeypatch.setattr(timescale, "get_hostname_pollution", lambda: None)
    settings = SimpleNamespace(
        app=SimpleNamespace(proxy_advisory=False),
        geoip=SimpleNamespace(asn_enabled=False),
    )
    assert health._collect_advisories(app=cast(Any, object()), settings=cast(Any, settings)) == []


def test_collect_advisories_survives_no_ingestion_service(monkeypatch) -> None:
    from types import SimpleNamespace
    from geometrikks.domain.system.controllers import health
    from geometrikks.server import runtime, timescale

    monkeypatch.setattr(runtime, "get_ingestion_service", lambda app: None)
    monkeypatch.setattr(timescale, "get_hostname_pollution", lambda: None)
    settings = SimpleNamespace(
        app=SimpleNamespace(proxy_advisory=True),
        geoip=SimpleNamespace(asn_enabled=False),
    )
    assert health._collect_advisories(app=cast(Any, object()), settings=cast(Any, settings)) == []
