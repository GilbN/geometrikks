"""Shared query-parameter declarations reused across API controllers.

These are ``Annotated`` aliases. Every alias carries an explicit camelCase
``name=`` (the public API casing policy); handler argument names stay
snake_case Python.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from litestar.openapi.spec import Example
from litestar.params import QueryParameter

# LiveRangeExamplesJsonPlugin swaps these two strings for the last 24 hours in the served
# /schema/openapi.json, so they must stay unique and must not appear as real data in the schema.
EXAMPLE_RANGE_START = "2026-11-01T00:00:00Z"
EXAMPLE_RANGE_END = "2026-11-02T00:00:00Z"


def range_start_examples() -> list[Example]:
    return [Example(value=EXAMPLE_RANGE_START)]


def range_end_examples() -> list[Example]:
    return [Example(value=EXAMPLE_RANGE_END)]


_RANGE_START = f"Start of the range, inclusive, as ISO 8601 with a timezone, such as `{EXAMPLE_RANGE_START}`."
_RANGE_END = f"End of the range, exclusive, as ISO 8601 with a timezone, such as `{EXAMPLE_RANGE_END}`."
GEO_WHOLE_BUCKETS_NOTE = (
    "count whole hours or UTC days, from the one that holds `fromTimestamp` through the last one that starts "
    "before `toTimestamp`"
)


def local_days_edge_note(start_name: str, end_name: str) -> str:
    """The bucket edges of an aggregate read with daily buckets in a non-UTC zone."""
    return (
        "With `granularity=daily` and a `tz` other than UTC on a range of 30 days or less, those reads count "
        "local days instead. They start at the local midnight of the day holding "
        f"`{start_name}` and run through the last hour that starts before `{end_name}`."
    )


REPEAT_NOTE = "Repeat the parameter to pass more than one."
_IP_CHECK = "A value that is not an IP gets a 400."
COUNTRY_FILTER_DESCRIPTION = (
    f"Keep only these countries, as uppercase two-letter ISO 3166-1 codes such as `NO`. {REPEAT_NOTE}"
)
CITY_FILTER_DESCRIPTION = f"Keep only these cities, by the exact name GeoIP gives, such as `Oslo`. {REPEAT_NOTE}"

FromTimestamp = Annotated[
    datetime,
    QueryParameter(
        name="fromTimestamp",
        description=_RANGE_START,
        examples=range_start_examples(),
    ),
]

ToTimestamp = Annotated[
    datetime,
    QueryParameter(
        name="toTimestamp",
        description=_RANGE_END,
        examples=range_end_examples(),
    ),
]

# The analytics endpoints keep their own wire names for the same window.
StartDate = Annotated[
    datetime,
    QueryParameter(
        name="startDate",
        description=_RANGE_START,
        examples=range_start_examples(),
    ),
]

EndDate = Annotated[
    datetime,
    QueryParameter(
        name="endDate",
        description=_RANGE_END,
        examples=range_end_examples(),
    ),
]

Timezone = Annotated[
    str | None,
    QueryParameter(
        name="tz",
        description=(
            "An IANA timezone such as `Europe/Oslo`. Daily buckets then start at midnight in that zone for "
            "ranges of 30 days or less, and longer ranges keep UTC days unless the endpoint's description says "
            "otherwise. Hourly buckets ignore it, so on ranges that get hourly buckets it changes nothing. An "
            "unknown zone gets a 400. Defaults to UTC."
        ),
        examples=[Example(value="Europe/Oslo")],
        required=False,
    ),
]

ChartGranularity = Annotated[
    Literal["hourly", "daily"] | None,
    QueryParameter(
        description=(
            "`hourly` or `daily` buckets. Leave it out to get hourly buckets for ranges up to 30 days and "
            "daily buckets for longer ones."
        ),
        required=False,
    ),
]

ComparePrevious = Annotated[
    bool,
    QueryParameter(
        name="comparePrevious",
        description=(
            "Also return the period of the same length just before the range, and the percent change from it. "
            "Defaults to false."
        ),
    ),
]

CountryCodeFilter = Annotated[
    list[str] | None,
    QueryParameter(
        name="countryCode",
        description=COUNTRY_FILTER_DESCRIPTION,
        required=False,
    ),
]

CityFilter = Annotated[
    list[str] | None,
    QueryParameter(
        name="city",
        description=CITY_FILTER_DESCRIPTION,
        required=False,
    ),
]

IpAddressFilter = Annotated[
    list[str] | None,
    QueryParameter(
        name="ipAddress",
        description=f"Keep only these client IPs. {REPEAT_NOTE} {_IP_CHECK}",
        required=False,
    ),
]

IpAddressExcludeFilter = Annotated[
    list[str] | None,
    QueryParameter(
        name="ipAddressNotIn",
        description=f"Leave out these client IPs. {REPEAT_NOTE} {_IP_CHECK}",
        required=False,
    ),
]

# camelCase-named variants used by the geo endpoints.
IpAddressIn = Annotated[
    list[str] | None,
    QueryParameter(
        name="ipAddressIn",
        description=f"Keep only these client IPs. {REPEAT_NOTE} {_IP_CHECK}",
        required=False,
    ),
]

IpAddressNotIn = Annotated[
    list[str] | None,
    QueryParameter(
        name="ipAddressNotIn",
        description=f"Leave out these client IPs. {REPEAT_NOTE} {_IP_CHECK}",
        required=False,
    ),
]

ServerIn = Annotated[
    list[str] | None,
    QueryParameter(
        name="serverIn",
        description=f"Keep only rows recorded under these server names. {REPEAT_NOTE}",
        required=False,
    ),
]

ServerNotIn = Annotated[
    list[str] | None,
    QueryParameter(
        name="serverNotIn",
        description=(
            f"Leave out rows recorded under these server names. {REPEAT_NOTE} Rows without a server name stay in."
        ),
        required=False,
    ),
]

AsnIn = Annotated[
    list[int] | None,
    QueryParameter(
        name="asnIn",
        description=(
            f"Keep only these autonomous system numbers, such as `13335`. {REPEAT_NOTE} Rows without ASN data are left "
            "out."
        ),
        required=False,
    ),
]

AsnNotIn = Annotated[
    list[int] | None,
    QueryParameter(
        name="asnNotIn",
        description=f"Leave out these autonomous system numbers. {REPEAT_NOTE} Rows without ASN data stay in.",
        required=False,
    ),
]
