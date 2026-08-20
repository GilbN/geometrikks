"""Hostname-pollution probe: container-ID heuristics behind the CAGG gate."""
from __future__ import annotations

from geometrikks.server.timescale import (
    CONTAINER_ID_THRESHOLD,
    DISTINCT_HOSTNAME_CEILING,
    classify_hostnames,
)


def test_clean_homelab_hostnames_are_not_polluted():
    result = classify_hostnames(["nginx-01", "traefik-01", "vps-9"])
    assert result.distinct_count == 3
    assert result.container_id_count == 0
    assert result.polluted is False


def test_container_id_shapes_trip_the_threshold():
    ids = [f"{i:012x}" for i in range(CONTAINER_ID_THRESHOLD)]
    result = classify_hostnames(ids + ["nginx-01"])
    assert result.container_id_count == CONTAINER_ID_THRESHOLD
    assert result.polluted is True


def test_below_threshold_container_ids_are_tolerated():
    ids = [f"{i:012x}" for i in range(CONTAINER_ID_THRESHOLD - 1)]
    assert classify_hostnames(ids + ["nginx-01"]).polluted is False


def test_cardinality_ceiling_trips_without_container_ids():
    many = [f"host-{i}" for i in range(DISTINCT_HOSTNAME_CEILING + 1)]
    result = classify_hostnames(many)
    assert result.polluted is True
    assert result.reason == "hostname-count"


def test_container_ids_win_the_reason_when_both_thresholds_trip():
    ids = [f"{i:012x}" for i in range(CONTAINER_ID_THRESHOLD)]
    many = [f"host-{i}" for i in range(DISTINCT_HOSTNAME_CEILING + 1)]
    assert classify_hostnames(ids + many).reason == "container-ids"


def test_clean_hostnames_have_no_reason():
    assert classify_hostnames(["nginx-01"]).reason is None


def test_capped_probe_labels_the_count_as_a_floor():
    """The probe stops at ceiling+1 rows, so the count is a lower bound and
    must not be rendered as an exact total."""
    capped = classify_hostnames([f"host-{i}" for i in range(DISTINCT_HOSTNAME_CEILING + 1)])
    assert capped.probe_capped is True
    assert capped.distinct_label == f"{DISTINCT_HOSTNAME_CEILING}+"


def test_uncapped_probe_labels_the_exact_count():
    result = classify_hostnames(["nginx-01", "traefik-01"])
    assert result.probe_capped is False
    assert result.distinct_label == "2"


def test_non_hex_twelve_char_names_are_not_container_ids():
    # 'geometrikks1' is 12 chars but not pure hex
    assert classify_hostnames(["geometrikks1"]).container_id_count == 0


def test_empty_database_is_clean():
    result = classify_hostnames([])
    assert result.polluted is False
