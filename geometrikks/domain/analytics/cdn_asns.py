"""ASNs whose presence as the *peer* means the proxy is logging a CDN edge.

Deliberately separate from hosting_asns.csv: that list answers "is this
traffic probably automated", this one answers "is my geo data wrong".
CDN77 (60068) appears in both, which is harmless.

Imperva and Sucuri are fronting WAFs rather than CDNs, but the symptom is
identical: every peer is their scrubbing network.

Hyperscalers (AWS 16509/14618, GCP 15169, Azure 8075) stay out: inbound
traffic from those is scanners, not a fronting CDN. The cost is that
CloudFront, Azure Front Door and Cloud CDN setups never get the advisory.

Edgio/Limelight (22822) was removed: the network shut down 2025-01-15 and
the ASN is no longer announced. Do not re-add it.

Org names checked against RIPEstat (https://stat.ripe.net/data/as-overview/data.json?resource=AS<asn>) on 2026-09-01.
"""
from __future__ import annotations

CDN_ASNS: dict[int, str] = {
    13335: "Cloudflare",
    209242: "Cloudflare",
    54113: "Fastly",
    20940: "Akamai",
    16625: "Akamai",
    35994: "Akamai",
    60068: "CDN77",
    199524: "G-Core",
    200325: "bunny.net",
    19551: "Imperva",
    30148: "Sucuri",
}
