from ipaddress import ip_network

import pytest

from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.domain.muted_ips.networks import (
    normalize_network,
    normalize_note,
    with_mapped_twins,
)


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("203.0.113.7", "203.0.113.7/32"),
        (" 10.0.0.0/8 ", "10.0.0.0/8"),
        ("2001:DB8::5", "2001:db8::5/128"),
        ("::ffff:192.0.2.10", "192.0.2.10/32"),
        ("::ffff:192.0.2.0/120", "192.0.2.0/24"),
        ("::ffff:0:0/96", "0.0.0.0/0"),
    ],
)
def test_normalize_network_stores_canonical_form(raw, stored):
    assert str(normalize_network(raw)) == stored


@pytest.mark.parametrize("raw", ["fe80::1%eth0", "fe80::1%eth0/64", "not-an-ip", "", "10.0.0.0/33"])
def test_normalize_network_rejects(raw):
    with pytest.raises(DomainValidationError) as error:
        normalize_network(raw)
    assert error.value.code == "invalid_network"


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (
            "10.0.0.5/8",
            "10.0.0.5/8 is not the start of a range. Enter 10.0.0.0/8 for the range, or 10.0.0.5 for one address",
        ),
        (
            "2001:db8::5/64",
            "2001:db8::5/64 is not the start of a range. Enter 2001:db8::/64 for the range, or 2001:db8::5 for one address",
        ),
        (
            "::ffff:192.0.2.0/96",
            "::ffff:192.0.2.0/96 is not the start of a range. Enter ::ffff:0.0.0.0/96 for the range, or ::ffff:192.0.2.0 for one address",
        ),
    ],
)
def test_normalize_network_rejects_host_bits_and_names_both_fixes(raw, message):
    with pytest.raises(DomainValidationError) as error:
        normalize_network(raw)
    assert error.value.code == "invalid_network"
    assert str(error.value) == message


def test_normalize_note_strips_and_empties_to_none():
    assert normalize_note("  home fibre ") == "home fibre"
    assert normalize_note("   ") is None
    assert normalize_note(None) is None


def test_normalize_note_over_100_is_invalid_note():
    with pytest.raises(DomainValidationError) as error:
        normalize_note("x" * 101)
    assert error.value.code == "invalid_note"


def test_with_mapped_twins_adds_mapped_form_for_ipv4_only():
    networks = [ip_network("203.0.113.7/32"), ip_network("192.0.2.0/24"), ip_network("2001:db8::/64")]
    assert {str(network) for network in with_mapped_twins(networks)} == {
        "203.0.113.7/32",
        "::ffff:203.0.113.7/128",
        "192.0.2.0/24",
        "::ffff:192.0.2.0/120",
        "2001:db8::/64",
    }


def test_normalize_note_rejects_nul_which_postgres_cannot_store():
    with pytest.raises(DomainValidationError) as error:
        normalize_note("home\x00fibre")
    assert error.value.code == "invalid_note"
