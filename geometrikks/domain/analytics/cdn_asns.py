"""ASNs whose presence as the *peer* means the proxy is logging a CDN edge.

Deliberately separate from hosting_asns.csv: that list answers "is this
traffic probably automated", this one answers "is my geo data wrong".
CDN77 (60068) appears in both, which is harmless.

Hyperscalers (AWS 16509/14618, GCP 15169, Azure 8075) stay out: inbound
traffic from those is scanners, not a fronting CDN.

Org names taken from the 2026-08-30 spec; re-check against bgp.tools before release.
"""
from __future__ import annotations

CDN_ASNS: dict[int, str] = {
    13335: "Cloudflare",
    209242: "Cloudflare",
    54113: "Fastly",
    20940: "Akamai",
    16625: "Akamai",
    60068: "CDN77",
    22822: "Edgio",
    199524: "G-Core",
}
