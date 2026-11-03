"""Plain schemas for access-log query results - pure data, no ORM dependencies."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

import msgspec


class CountryFacet(msgspec.Struct, rename="camel"):
    """A country that appears in the access logs."""

    code: Annotated[str, msgspec.Meta(description="The two-letter ISO 3166-1 code, such as `NO`.")]
    name: Annotated[str, msgspec.Meta(description="The country name, or the code when GeoIP gave no name.")]


class AccessLogFacets(msgspec.Struct, rename="camel"):
    """The values the access log filters can take, each list sorted."""

    countries: Annotated[list[CountryFacet], msgspec.Meta(description="Sorted by name.")]
    cities: list[str]
    hosts: Annotated[list[str], msgspec.Meta(description="The Host header values the lines carry.")]
    servers: Annotated[list[str], msgspec.Meta(description="The server names that recorded access logs.")]
    log_formats: Annotated[
        list[str],
        msgspec.Meta(description="The log formats the lines were read with, such as `nginx` or `traefik-json`."),
    ]


RawLineFieldGroup = Literal["request_header", "response_header", "origin_header", "field"]


class RawLineField(msgspec.Struct, rename="camel", kw_only=True):
    """One key of a JSON log line."""

    key: Annotated[
        str,
        msgspec.Meta(
            description=(
                "The key, with dots between the levels of a nested key. A header key is the header name "
                "without its prefix, such as `User-Agent`."
            )
        ),
    ]
    value: Annotated[
        str,
        msgspec.Meta(
            description=(
                "The value as text. GeoMetrikks joins a list of strings with commas and writes other values as "
                "compact JSON."
            )
        ),
    ]
    group: Annotated[
        RawLineFieldGroup,
        msgspec.Meta(
            description=(
                "`request_header`, `response_header` or `origin_header` for a header the proxy logged, and "
                "`field` for any other key."
            )
        ),
    ]
    stored_as: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The access log field this key fills, as a label such as `IP address`. Null when GeoMetrikks "
                "does not store the key."
            )
        ),
    ] = None


class RawLineFields(msgspec.Struct, rename="camel", kw_only=True):
    """A JSON log line split into its keys, in the order they appear in the line."""

    format: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The JSON log format that read the line into its access log line, such as `traefik-json`. Null "
                "when the line produced no access log line or no JSON format accepts it, and then no field has "
                "`storedAs`."
            )
        ),
    ]
    fields: list[RawLineField]


class AccessLogDebugEntry(msgspec.Struct, rename="camel"):
    """One stored raw log line, with the fields of the access log line it produced.

    The access log fields are copies made when GeoMetrikks stored the line. They are null when the line
    did not parse into an access log line.
    """

    id: int
    created_at: Annotated[datetime, msgspec.Meta(description="When GeoMetrikks stored the line, in UTC.")]
    raw_line: Annotated[str, msgspec.Meta(description="The line as the log had it, with null bytes replaced.")]
    is_malformed: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "True for a line that did not match the log format, or that looks like a probe such as a TLS "
                "handshake sent to the HTTP port."
            )
        ),
    ]
    access_log_id: Annotated[
        int | None, msgspec.Meta(description="The `id` of the access log line this line produced.")
    ] = None
    parse_error: Annotated[
        str | None, msgspec.Meta(description="Why the line counts as malformed. Null for a well-formed line.")
    ] = None
    log_format: Annotated[
        str | None,
        msgspec.Meta(
            description="The log format that read the line. Null on lines stored before GeoMetrikks recorded it."
        ),
    ] = None
    timestamp: Annotated[datetime | None, msgspec.Meta(description="The request time from the line, in UTC.")] = None
    ip_address: str | None = None
    method: str | None = None
    url: str | None = None
    host: str | None = None
    status_code: int | None = None
    country_code: str | None = None
    country_name: str | None = None
    city: str | None = None
    user_agent: str | None = None
    raw_fields: Annotated[
        RawLineFields | None,
        msgspec.Meta(
            description=(
                "The line split into its keys when it is a JSON object. Null for any other line, and for an "
                "object with key paths more than six levels deep or more than 200 flattened fields."
            )
        ),
    ] = None


class ParseErrorCount(msgspec.Struct, rename="camel"):
    """A parse error and how many stored lines carry it."""

    error: str
    count: int


class AccessLogDebugStats(msgspec.Struct, rename="camel"):
    """Counts of the raw log lines stored in a time range."""

    total: Annotated[int, msgspec.Meta(description="Stored lines in the range.")]
    malformed: Annotated[int, msgspec.Meta(description="Stored lines in the range that count as malformed.")]
    top_parse_error: Annotated[
        ParseErrorCount | None,
        msgspec.Meta(
            description=(
                "The parse error the most lines carry, with ties going to the first in alphabetical order. Null "
                "when no line in the range has one."
            )
        ),
    ] = None
