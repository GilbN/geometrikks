"""Shared validation helpers for client-supplied values."""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable

from geometrikks.domain.exceptions import DomainValidationError


def validate_ip_address(value: str) -> str:
    """Reject a non-IP value before it reaches an INET bind param.

    ``ip_address`` columns are INET, so asyncpg would otherwise fail to
    encode the bind param and surface a 500 instead of a 400.

    Raises:
        DomainValidationError: If the value is not a valid IP address.
    """
    try:
        ipaddress.ip_address(value)
    except ValueError as exc:
        raise DomainValidationError(f"Invalid IP address: {value!r}") from exc
    return value


def validate_ip_addresses(values: Iterable[str]) -> None:
    """Validate every value with :func:`validate_ip_address`."""
    for raw in values:
        validate_ip_address(raw)
