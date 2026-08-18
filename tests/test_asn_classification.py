"""Read-time ASN categorization over the vendored hosting-ASN list."""
from __future__ import annotations

from geometrikks.domain.analytics.asn_classification import (
    classify_asn,
    hosting_asn_count,
)


def test_known_hosting_asn_is_datacenter():
    # AS16509 AMAZON-02: guaranteed present in any hosting-ASN list.
    assert classify_asn(16509) == "datacenter"


def test_private_asn_is_other():
    # 64512 opens the RFC 6996 private range; never in a public hosting list.
    assert classify_asn(64512) == "other"


def test_list_is_loaded_and_plausibly_sized():
    assert hosting_asn_count() > 500
