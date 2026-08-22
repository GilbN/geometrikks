"""Read-time ASN categorization over the vendored hosting-ASN list."""
from __future__ import annotations

from geometrikks.domain.analytics.asn_classification import (
    classify_asn,
    hosting_asn_count,
    hosting_asn_entries,
)


def test_known_hosting_asn_is_hosting():
    # AS16509 AMAZON-02: guaranteed present in any hosting-ASN list.
    assert classify_asn(16509) == "hosting"


def test_private_asn_is_other():
    # 64512 opens the RFC 6996 private range; never in a public hosting list.
    assert classify_asn(64512) == "other"


def test_list_is_loaded_and_plausibly_sized():
    assert hosting_asn_count() > 500


def test_entries_are_deduplicated_sorted_and_sized_like_the_set():
    # Upstream repeats some ASNs under different entity spellings; the
    # loader must collapse them so the browsable list and the classifier
    # agree on what "one entry" means.
    entries = hosting_asn_entries()
    asns = [asn for asn, _ in entries]
    assert len(asns) == len(set(asns)) == hosting_asn_count()
    assert asns == sorted(asns)


def test_entity_names_are_html_unescaped():
    # Upstream carries a few encoded values like Solu&#231;&#245;Es.
    assert not any("&#" in entity for _, entity in hosting_asn_entries())
