"""Plain schemas for access-log query results - pure data, no ORM dependencies."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CountryFacet:
    """One country present in the access-log data."""

    code: str
    """ISO-3166 alpha-2 code, e.g. ``NO``."""
    name: str
    """Display name, e.g. ``Norway`` (falls back to the code)."""


@dataclass
class AccessLogFacets:
    """Distinct filterable values present in the access-log data."""

    countries: list[CountryFacet]
    """Sorted by name."""
    cities: list[str]
    """Sorted alphabetically."""
