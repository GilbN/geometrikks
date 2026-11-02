"""DROP snapshot matching, staleness and the drop ASN category."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from ipaddress import ip_address

import pytest

from geometrikks.domain.analytics import asn_classification
from geometrikks.domain.analytics.asn_classification import classify_asn
from geometrikks.domain.drop import snapshot as snapshot_module
from geometrikks.domain.drop.snapshot import (
    EMPTY_DROP_SNAPSHOT,
    DropAsnEntry,
    DropNetworkMatch,
    DropSnapshot,
    FeedState,
    current_drop_snapshot,
    reset_drop_snapshot,
)

NETWORK_V4 = DropNetworkMatch(cidr="198.51.100.64/26", sbl_id="SBL000001")
NETWORK_V6 = DropNetworkMatch(cidr="2001:db8:254::/48", sbl_id="SBL000004")
ASN_ENTRY = DropAsnEntry(asn=64496, name="EXAMPLE-AS", country_code="NL")


def _feed_state(feed: str, fetched_at: datetime | None) -> FeedState:
    return FeedState(
        feed=feed,
        upstream_timestamp=None,
        record_count=1,
        copyright=None,
        fetched_at=fetched_at,
        checked_at=fetched_at,
        last_error=None,
    )


def _snapshot(*, networks=(NETWORK_V4, NETWORK_V6), asns=(ASN_ENTRY,)) -> DropSnapshot:
    return DropSnapshot(
        networks=tuple(networks),
        asns=tuple(asns),
        feeds=(_feed_state("v4", datetime.now(UTC)),),
    )


def test_network_for_matches_first_and_last_address_and_misses_neighbour():
    drop_snapshot = _snapshot()
    assert drop_snapshot.network_for("198.51.100.64") == NETWORK_V4
    assert drop_snapshot.network_for("198.51.100.127") == NETWORK_V4
    assert drop_snapshot.network_for("198.51.100.128") is None
    assert drop_snapshot.network_for("198.51.100.63") is None


def test_network_for_accepts_address_objects():
    assert _snapshot().network_for(ip_address("198.51.100.70")) == NETWORK_V4


def test_ipv4_mapped_ipv6_matches_the_ipv4_network():
    assert _snapshot().network_for("::ffff:198.51.100.100") == NETWORK_V4


def test_ipv6_network_matches():
    drop_snapshot = _snapshot()
    assert drop_snapshot.network_for("2001:db8:254::1") == NETWORK_V6
    assert drop_snapshot.network_for("2001:db8:255::1") is None


def test_ipv4_and_ipv6_ranges_do_not_cross_match():
    drop_snapshot = _snapshot(networks=[DropNetworkMatch(cidr="::/96", sbl_id="SBL1")])
    assert drop_snapshot.network_for("0.0.0.1") is None


def test_invalid_ip_returns_none():
    drop_snapshot = _snapshot()
    assert drop_snapshot.network_for("not-an-ip") is None
    assert drop_snapshot.network_for("") is None


def test_overlapping_networks_return_the_most_specific():
    wide = DropNetworkMatch(cidr="10.0.0.0/8", sbl_id="SBL1")
    narrow = DropNetworkMatch(cidr="10.1.0.0/16", sbl_id="SBL2")
    drop_snapshot = _snapshot(networks=[wide, narrow])
    assert drop_snapshot.network_for("10.1.2.3") == narrow
    assert drop_snapshot.network_for("10.2.0.1") == wide


def test_enclosing_network_is_found_after_a_disjoint_sibling():
    wide = DropNetworkMatch(cidr="10.0.0.0/8", sbl_id="SBL1")
    sibling = DropNetworkMatch(cidr="10.1.0.0/24", sbl_id="SBL2")
    drop_snapshot = _snapshot(networks=[wide, sibling])
    assert drop_snapshot.network_for("10.1.5.5") == wide


def test_empty_snapshot_matches_nothing_and_is_not_loaded():
    assert EMPTY_DROP_SNAPSHOT.network_for("198.51.100.65") is None
    assert EMPTY_DROP_SNAPSHOT.asn_entry(64496) is None
    assert EMPTY_DROP_SNAPSHOT.is_drop_asn(64496) is False
    assert EMPTY_DROP_SNAPSHOT.loaded is False
    assert EMPTY_DROP_SNAPSHOT.updated_at is None
    assert EMPTY_DROP_SNAPSHOT.stale is False


def test_asn_lookup():
    drop_snapshot = _snapshot()
    assert drop_snapshot.asn_entry(64496) == ASN_ENTRY
    assert drop_snapshot.is_drop_asn(64496)
    assert not drop_snapshot.is_drop_asn(64497)


def test_loaded_follows_fetched_at_and_updated_at_is_the_newest():
    older = datetime.now(UTC) - timedelta(days=2)
    newer = datetime.now(UTC) - timedelta(days=1)
    never_fetched = DropSnapshot(feeds=(_feed_state("v4", None),))
    assert never_fetched.loaded is False
    drop_snapshot = DropSnapshot(feeds=(_feed_state("v4", older), _feed_state("asn", newer)))
    assert drop_snapshot.loaded is True
    assert drop_snapshot.updated_at == newer


def test_asns_loaded_follows_the_asn_feed_alone():
    fetched_at = datetime.now(UTC)
    networks_only = DropSnapshot(feeds=(_feed_state("v4", fetched_at), _feed_state("v6", fetched_at), _feed_state("asn", None)))
    with_asns = DropSnapshot(feeds=(_feed_state("v4", None), _feed_state("asn", fetched_at)))
    assert networks_only.loaded is True
    assert networks_only.asns_loaded is False
    assert with_asns.asns_loaded is True
    assert EMPTY_DROP_SNAPSHOT.asns_loaded is False


def test_stale_after_seven_days():
    fresh = DropSnapshot(feeds=(_feed_state("v4", datetime.now(UTC) - timedelta(days=6)),))
    old = DropSnapshot(feeds=(_feed_state("v4", datetime.now(UTC) - timedelta(days=8)),))
    assert fresh.stale is False
    assert old.stale is True


def test_classify_asn_without_a_snapshot_is_unchanged():
    assert current_drop_snapshot() is EMPTY_DROP_SNAPSHOT
    assert classify_asn(16509) == "hosting"
    assert classify_asn(64496) == "other"


def test_classify_asn_reads_the_loaded_snapshot(monkeypatch):
    monkeypatch.setattr(snapshot_module, "_snapshot", _snapshot())
    assert classify_asn(64496) == "drop"
    assert classify_asn(16509) == "hosting"


def test_drop_wins_over_hosting_for_an_asn_on_both_lists(monkeypatch):
    on_both_lists = DropAsnEntry(asn=16509, name="AMAZON-02", country_code="US")
    monkeypatch.setattr(snapshot_module, "_snapshot", _snapshot(asns=[on_both_lists]))
    assert asn_classification.classify_asn(16509) == "drop"


def test_classify_asn_uses_the_given_snapshot_over_the_global_one(monkeypatch):
    monkeypatch.setattr(snapshot_module, "_snapshot", _snapshot())
    assert classify_asn(64496, EMPTY_DROP_SNAPSHOT) == "other"
    monkeypatch.setattr(snapshot_module, "_snapshot", EMPTY_DROP_SNAPSHOT)
    assert classify_asn(64496, _snapshot()) == "drop"


def test_networks_loaded_needs_a_network_feed():
    fetched_at = datetime.now(UTC)
    asn_only = DropSnapshot(feeds=(_feed_state("v4", None), _feed_state("v6", None), _feed_state("asn", fetched_at)))
    v6_only = DropSnapshot(feeds=(_feed_state("v4", None), _feed_state("v6", fetched_at)))
    assert asn_only.loaded is True
    assert asn_only.networks_loaded is False
    assert v6_only.networks_loaded is True
    assert EMPTY_DROP_SNAPSHOT.networks_loaded is False
