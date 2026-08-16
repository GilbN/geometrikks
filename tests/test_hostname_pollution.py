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
    assert classify_hostnames(many).polluted is True


def test_non_hex_twelve_char_names_are_not_container_ids():
    # 'geometrikks1' is 12 chars but not pure hex
    assert classify_hostnames(["geometrikks1"]).container_id_count == 0


def test_empty_database_is_clean():
    result = classify_hostnames([])
    assert result.polluted is False
