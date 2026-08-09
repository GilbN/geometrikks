"""Shared query-parameter declarations reused across API controllers.

These are ``Annotated`` aliases. Every alias carries an explicit camelCase
``name=`` (the public API casing policy); handler argument names stay
snake_case Python.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from litestar.openapi.spec import Example
from litestar.params import QueryParameter

FromTimestamp = Annotated[
    datetime,
    QueryParameter(
        name="fromTimestamp",
        description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
        examples=[Example(value="2024-01-01T00:00:00Z")],
    ),
]

ToTimestamp = Annotated[
    datetime,
    QueryParameter(
        name="toTimestamp",
        description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
        examples=[Example(value="2024-12-31T23:59:59Z")],
    ),
]

# The analytics endpoints keep their own wire names for the same window.
StartDate = Annotated[
    datetime,
    QueryParameter(
        name="startDate",
        description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
        examples=[Example(value="2024-01-01T00:00:00Z")],
    ),
]

EndDate = Annotated[
    datetime,
    QueryParameter(
        name="endDate",
        description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
        examples=[Example(value="2024-12-31T23:59:59Z")],
    ),
]

Timezone = Annotated[
    str | None,
    QueryParameter(
        name="tz",
        description="IANA timezone for daily buckets (e.g. Europe/Oslo). When "
        "set, daily buckets are local days in this zone for ranges the hourly "
        "source data can serve (<= 30 days); longer ranges keep UTC days. "
        "Hourly buckets are unaffected.",
        examples=[Example(value="Europe/Oslo")],
        required=False,
    ),
]

CountryCodeFilter = Annotated[
    list[str] | None,
    QueryParameter(name="countryCode", description="Filter to these ISO country codes (repeatable)", required=False),
]

CityFilter = Annotated[
    list[str] | None,
    QueryParameter(name="city", description="Filter to these city names (repeatable)", required=False),
]

IpAddressFilter = Annotated[
    list[str] | None,
    QueryParameter(name="ipAddress", description="Filter to these client IPs (repeatable)", required=False),
]

IpAddressExcludeFilter = Annotated[
    list[str] | None,
    QueryParameter(name="ipAddressNotIn", description="Exclude these client IPs (repeatable)", required=False),
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
