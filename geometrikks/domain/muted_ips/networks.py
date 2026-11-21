"""Input rules for the muted IP list."""

from __future__ import annotations

from collections.abc import Iterable
from ipaddress import IPv4Network, IPv6Network, ip_network
from typing import Final

from geometrikks.domain.exceptions import DomainValidationError

MUTED_IPS_CAP: Final = 20
NOTE_MAX_LENGTH: Final = 100

_MAPPED_PREFIX: Final = 96
_MAPPED_BASE: Final = 0xFFFF << 32
_IPV4_MASK: Final = 0xFFFFFFFF

type Network = IPv4Network | IPv6Network


def normalize_network(raw: str) -> Network:
    """Parse one address or CIDR, host bits cleared, IPv4-mapped IPv6 collapsed to IPv4."""
    if "%" in raw:
        raise DomainValidationError("Remove the zone ID (the part after %) from the address", code="invalid_network")
    try:
        network = ip_network(raw.strip(), strict=False)
    except ValueError as error:
        raise DomainValidationError("Enter an IP address or CIDR network, such as 203.0.113.7 or 10.0.0.0/8", code="invalid_network") from error
    if isinstance(network, IPv6Network) and network.prefixlen >= _MAPPED_PREFIX:
        mapped_block = IPv6Network((_MAPPED_BASE, _MAPPED_PREFIX))
        if network.subnet_of(mapped_block):
            return IPv4Network((int(network.network_address) & _IPV4_MASK, network.prefixlen - _MAPPED_PREFIX))
    return network


def normalize_note(raw: str | None) -> str | None:
    if raw is None:
        return None
    note = raw.strip()
    if not note:
        return None
    if "\x00" in note:
        raise DomainValidationError("Remove the NUL character from the note", code="invalid_note")
    if len(note) > NOTE_MAX_LENGTH:
        raise DomainValidationError(f"Shorten the note to {NOTE_MAX_LENGTH} characters or fewer", code="invalid_note")
    return note


def with_mapped_twins(networks: Iterable[Network]) -> list[Network]:
    """Each IPv4 network plus its ::ffff: form, since log rows may store either."""
    expanded: list[Network] = []
    for network in networks:
        expanded.append(network)
        if isinstance(network, IPv4Network):
            expanded.append(
                IPv6Network((_MAPPED_BASE | int(network.network_address), _MAPPED_PREFIX + network.prefixlen))
            )
    return expanded
