"""Shared query-parameter declarations reused across API controllers.

These are ``Annotated`` aliases: unless a declaration carries an explicit
``name=``, the wire-level query-parameter name still comes from the handler
argument name, so reusing an alias across handlers never changes the wire
contract.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from litestar.openapi.spec import Example
from litestar.params import QueryParameter

StartTimestamp = Annotated[
    datetime,
    QueryParameter(
        description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
        examples=[Example(value="2024-01-01T00:00:00Z")],
    ),
]

EndTimestamp = Annotated[
    datetime,
    QueryParameter(
        description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
        examples=[Example(value="2024-12-31T23:59:59Z")],
    ),
]

CountryCodeFilter = Annotated[
    list[str] | None,
    QueryParameter(description="Filter to these ISO country codes (repeatable)", required=False),
]

CityFilter = Annotated[
    list[str] | None,
    QueryParameter(description="Filter to these city names (repeatable)", required=False),
]

IpAddressFilter = Annotated[
    list[str] | None,
    QueryParameter(description="Filter to these client IPs (repeatable)", required=False),
]

IpAddressExcludeFilter = Annotated[
    list[str] | None,
    QueryParameter(description="Exclude these client IPs (repeatable)", required=False),
]

# camelCase-named variants used by the geo endpoints.
IpAddressIn = Annotated[
    list[str] | None,
    QueryParameter(name="ipAddressIn", description="Filter to these IPs (repeatable)", required=False),
]

IpAddressNotIn = Annotated[
    list[str] | None,
    QueryParameter(name="ipAddressNotIn", description="Exclude these IPs (repeatable)", required=False),
]

HostnameIn = Annotated[
    list[str] | None,
    QueryParameter(
        name="hostnameIn",
        description="Filter to these recording hostnames (repeatable)",
        required=False,
    ),
]
