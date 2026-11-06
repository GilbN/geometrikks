"""A GeoLite2 stand-in for seeder tests: the fixture mmdb files cover too few IPs to sample from."""
from __future__ import annotations

import ipaddress

import geohash2

from tests.seed.visitors import Place, Resolved

# (latitude, longitude, country code, country name, city, ASN, organization, hosting)
FAKE_PLACES = (
    (59.9133, 10.7389, "NO", "Norway", "Oslo", 2119, "Telenor Norge AS", False),
    (58.97, 5.7331, "NO", "Norway", "Stavanger", 29695, "Lyse Tele", False),
    (52.3824, 4.8995, "NL", "Netherlands", "Amsterdam", 14061, "DigitalOcean, LLC", True),
    (50.1188, 8.6843, "DE", "Germany", "Frankfurt am Main", 24940, "Hetzner Online GmbH", True),
    (39.0469, -77.4903, "US", "United States", "Ashburn", 16509, "Amazon.com, Inc.", True),
    (40.7157, -74.0, "US", "United States", "New York", 7922, "Comcast Cable Communications, LLC", False),
    (35.6893, 139.6899, "JP", "Japan", "Tokyo", 4713, "NTT Communications Corporation", False),
    (-23.5335, -46.6359, "BR", "Brazil", None, 28573, "Claro NXT Telecomunicacoes Ltda", False),
)


def fake_place(index: int) -> Place:
    """``FAKE_PLACES[index]`` as a geo_locations row."""
    latitude, longitude, code, name, city, *_ = FAKE_PLACES[index]
    return Place(
        latitude=latitude,
        longitude=longitude,
        geohash=geohash2.encode(latitude, longitude),
        country_code=code,
        country_name=name,
        state=None,
        state_code=None,
        city=city,
        postal_code=None,
        timezone="Europe/Oslo" if code == "NO" else None,
    )


class FakeGeoSource:
    """Resolves every public IP to one of ``FAKE_PLACES``, fixed per address."""

    def resolve(self, ip: str) -> Resolved | None:
        index = int(ipaddress.ip_address(ip)) % len(FAKE_PLACES)
        _, _, _, _, _, asn, org, _ = FAKE_PLACES[index]
        return Resolved(place=fake_place(index), asn=asn, asn_org=org)

    def is_hosting(self, asn: int | None) -> bool:
        return any(asn == entry[5] and entry[7] for entry in FAKE_PLACES)
