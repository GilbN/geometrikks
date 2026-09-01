"""The CDN peer list: shape and deliberate exclusions."""
from __future__ import annotations

from geometrikks.domain.analytics.cdn_asns import CDN_ASNS


def test_cdn_asns_shape() -> None:
    assert CDN_ASNS, "list must not be empty"
    for asn, provider in CDN_ASNS.items():
        assert isinstance(asn, int) and asn > 0
        assert isinstance(provider, str) and provider


def test_cloudflare_present() -> None:
    assert CDN_ASNS[13335] == "Cloudflare"


def test_dead_networks_excluded() -> None:
    """Edgio (22822) shut down 2025-01-15 and no longer announces routes."""
    assert 22822 not in CDN_ASNS


def test_hyperscalers_excluded() -> None:
    """AWS/GCP/Azure inbound traffic is scanners, not a fronting CDN;
    including them would fire on every low-traffic site."""
    for hyperscaler in (16509, 14618, 15169, 8075):
        assert hyperscaler not in CDN_ASNS
