"""Shared validation helpers for client-supplied values."""

from __future__ import annotations

import ipaddress
import zoneinfo
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


def validate_timezone(value: str) -> str:
    """Reject anything that is not an installed IANA timezone name.

    The value is only ever bound as a query parameter, but an unknown zone
    would make ``time_bucket()`` raise mid-query and surface a 500 instead
    of a 400.

    Raises:
        DomainValidationError: If the value is not a known timezone.
    """
    try:
        zoneinfo.ZoneInfo(value)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError) as exc:
        raise DomainValidationError(f"Unknown timezone: {value!r}") from exc
    return value
