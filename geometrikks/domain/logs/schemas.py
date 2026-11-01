"""Plain schemas for access-log query results - pure data, no ORM dependencies."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

import msgspec


class CountryFacet(msgspec.Struct, rename="camel"):
    """One country present in the access-log data."""

    code: str
    """ISO-3166 alpha-2 code, e.g. ``NO``."""
    name: str
    """Display name, e.g. ``Norway`` (falls back to the code)."""


class AccessLogFacets(msgspec.Struct, rename="camel"):
    """Distinct filterable values present in the access-log data."""

    countries: list[CountryFacet]
    """Sorted by name."""
    cities: list[str]
    """Sorted alphabetically."""
    hosts: list[str]
    """Distinct HTTP Host values, sorted alphabetically. NULLs excluded."""
    servers: list[str]
    """Distinct servers that recorded access logs, sorted alphabetically. NULLs excluded."""
    log_formats: list[str]
    """Distinct source log formats ('nginx', 'traefik-json'). NULLs excluded."""


RawLineFieldGroup = Literal["request_header", "response_header", "origin_header", "field"]


class RawLineField(msgspec.Struct, rename="camel", kw_only=True):
    """One key from a JSON raw line, flattened for display."""

    key: str
    """Dotted path for nested keys; header name without its prefix for headers."""
    value: str
    """Strings as-is, string lists comma-joined, everything else as compact JSON."""
    group: RawLineFieldGroup
    stored_as: str | None = None
    """Access-log column this key fills, or None when GeoMetrikks drops it."""


class RawLineFields(msgspec.Struct, rename="camel", kw_only=True):
    """A JSON raw line split into fields, in the order they appear in the line."""

    format: str | None
    """Parser that read the line into its linked access log. None for an
    unlinked line or JSON no parser accepts, and then no field has ``stored_as``."""
    fields: list[RawLineField]


class AccessLogDebugEntry(msgspec.Struct, rename="camel"):
    """One debug row with its access-log context, flattened for the table.

    The context fields are read straight off access_log_debug, where ingestion
    denormalized them; nothing here joins access_logs. They are None when the
    raw line never parsed into an access_logs row (access_log_id is a soft
    reference; no FK on hypertables).
    """

    id: int
    created_at: datetime
    raw_line: str
    is_malformed: bool
    access_log_id: int | None = None
    parse_error: str | None = None
    timestamp: datetime | None = None
    ip_address: str | None = None
    method: str | None = None
    url: str | None = None
    host: str | None = None
    status_code: int | None = None
    country_code: str | None = None
    country_name: str | None = None
    city: str | None = None
    user_agent: str | None = None
    raw_fields: RawLineFields | None = None
    """The raw line as fields when it is a JSON object, else None."""


class ParseErrorCount(msgspec.Struct, rename="camel"):
    """A parse_error value and how many debug rows carry it."""

    error: str
    count: int


class AccessLogDebugStats(msgspec.Struct, rename="camel"):
    """Aggregates for the debug-logs stat cards, scoped to a time range."""

    total: int
    malformed: int
    top_parse_error: ParseErrorCount | None = None
