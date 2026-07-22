"""Trusted-proxy X-Forwarded-For resolution."""
from __future__ import annotations

from ipaddress import ip_network

from geometrikks.lib.client_ip import resolve_client_ip

TRUSTED = [ip_network("172.18.0.0/16"), ip_network("10.0.0.5/32")]


class _Headers:
    """Minimal stand-in for litestar's Headers, supporting getall()."""

    def __init__(self, data: dict[str, list[str]]) -> None:
        self._data = data

    def get(self, key: str, default: str | None = None) -> str | None:
        values = self._data.get(key.lower())
        return values[0] if values else default

    def getall(self, key: str, default: list[str] | None = None) -> list[str]:
        return self._data.get(key.lower(), default if default is not None else [])


class FakeConnection:
    """Duck-typed stand-in for litestar's ASGIConnection."""

    def __init__(self, peer: str | None, headers: dict[str, str | list[str]] | None = None) -> None:
        class _Client:
            host = peer

        self.client = _Client() if peer is not None else None
        raw = headers or {}
        self.headers = _Headers({k.lower(): v if isinstance(v, list) else [v] for k, v in raw.items()})


def test_no_trusted_networks_returns_peer_and_ignores_header():
    conn = FakeConnection("203.0.113.7", {"x-forwarded-for": "8.8.8.8"})
    assert resolve_client_ip(conn, trusted_networks=[]) == "203.0.113.7"


def test_untrusted_peer_cannot_spoof_via_header():
    conn = FakeConnection("203.0.113.7", {"x-forwarded-for": "8.8.8.8"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_trusted_peer_single_forwarded_entry():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "203.0.113.7"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_trusted_chain_skips_trusted_hops():
    # client, then an inner proxy (10.0.0.5), observed by the edge (peer).
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "203.0.113.7, 10.0.0.5"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_client_supplied_garbage_left_of_real_ip_is_ignored():
    # The attacker sent their own X-Forwarded-For; the proxy appended the truth.
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "8.8.8.8, 203.0.113.7"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_missing_header_falls_back_to_peer():
    conn = FakeConnection("172.18.0.2")
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "172.18.0.2"


def test_malformed_header_falls_back_to_peer():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "unknown, garbage"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "172.18.0.2"


def test_all_entries_trusted_falls_back_to_peer():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "10.0.0.5"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "172.18.0.2"


def test_ipv6_entry_with_brackets():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "[2001:db8::1]"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "2001:db8::1"


def test_no_client_returns_none():
    assert resolve_client_ip(FakeConnection(None), trusted_networks=TRUSTED) is None


def test_non_ip_peer_is_returned_verbatim():
    # litestar's TestClient reports a hostname peer; never crash on it.
    conn = FakeConnection("testclient", {"x-forwarded-for": "203.0.113.7"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "testclient"


def test_duplicate_xff_header_occurrences_are_joined():
    # The client sent its own X-Forwarded-For; HAProxy's "option forwardfor"
    # appends a separate header occurrence rather than merging it in.
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": ["8.8.8.8", "203.0.113.7"]})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_duplicate_xff_header_occurrences_with_multiple_entries_each():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": ["8.8.8.8, 6.6.6.6", "203.0.113.7"]})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "203.0.113.7"


def test_ipv6_zone_id_is_rejected_and_falls_back_to_peer():
    # Zone IDs can carry arbitrary bytes, including newlines, and would
    # otherwise round-trip through str() into log lines unfiltered.
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "fe80::1%eth0"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "172.18.0.2"


def test_malformed_entry_behind_trusted_hop_falls_back_to_peer():
    conn = FakeConnection("172.18.0.2", {"x-forwarded-for": "203.0.113.7, garbage, 10.0.0.5"})
    assert resolve_client_ip(conn, trusted_networks=TRUSTED) == "172.18.0.2"
