"""Bespoke response schemas and filters for the geo-logs endpoints.

msgspec Structs with camelCase renaming (litestar-recommended style for new
code). Required fields are deliberately default-less: defaults would make
them non-required in OpenAPI, which turns into optional fields in the
generated TS client.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

import msgspec


class GeoLogEntry(msgspec.Struct, rename="camel"):
    """One grouped (location, IP) row for the geo-logs table."""

    location_id: int
    city: str | None
    postal_code: str | None
    state: str | None
    state_code: str | None
    country_code: str
    country_name: str
    ip_address: str
    latitude: float
    longitude: float
    event_count: int
    last_seen: datetime | None
    hostnames: list[str]
    """Distinct hostnames seen for this group; [] on the CAGG path (the
    daily CAGG carries no hostname dimension)."""


class GeoLogPeriod(msgspec.Struct, rename="camel"):
    """Aggregate geo-event metrics for one period."""

    total_events: int
    unique_ips: int
    unique_countries: int
    unique_cities: int


class GeoLogPercentChange(msgspec.Struct, rename="camel"):
    """Percent change vs the previous period (None when previous is 0)."""

    total_events: float | None
    unique_ips: float | None
    unique_countries: float | None
    unique_cities: float | None


class GeoLogSummaryResponse(msgspec.Struct, rename="camel"):
    """Summary stats for the geo-logs stat cards."""

    start_date: str
    end_date: str
    current_period: GeoLogPeriod
    previous_period: GeoLogPeriod | None
    percent_changes: GeoLogPercentChange | None


class GeoLogTimeSeriesPoint(msgspec.Struct, rename="camel"):
    """One chart bucket."""

    timestamp: datetime
    total_events: int
    unique_ips: int


class GeoLogTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Bucketed geo-event series for the geo-logs chart."""

    granularity: str
    start_date: str
    end_date: str
    data: list[GeoLogTimeSeriesPoint]


class TopGeoIp(msgspec.Struct, rename="camel"):
    """Top IP by event count across all locations."""

    ip_address: str
    event_count: int
    country_code: str | None
    city: str | None


class TopGeoIpsResponse(msgspec.Struct, rename="camel"):
    items: list[TopGeoIp]


class TopGeoCountry(msgspec.Struct, rename="camel"):
    """Top country by event count."""

    country_code: str
    country_name: str | None
    event_count: int
    unique_ips: int


class TopGeoCountriesResponse(msgspec.Struct, rename="camel"):
    items: list[TopGeoCountry]


class TopGeoCity(msgspec.Struct, rename="camel"):
    """Top city by event count (NULL cities excluded)."""

    city: str
    country_code: str | None
    event_count: int
    unique_ips: int


class TopGeoCitiesResponse(msgspec.Struct, rename="camel"):
    items: list[TopGeoCity]


class GeoCountryFacet(msgspec.Struct, rename="camel"):
    """One country present in the geo data."""

    code: str
    name: str


class GeoEventFacets(msgspec.Struct, rename="camel"):
    """Distinct filterable values present in the geo data."""

    countries: list[GeoCountryFacet]
    cities: list[str]
    hostnames: list[str]


@dataclass
class GeoEventFilters:
    """Optional dimension filters for geo-event aggregate queries.

    Hostname filtering forces the raw geo_events path: no CAGG carries a
    hostname dimension. The other filters work on the CAGG paths too
    (ip_location_daily_stats is keyed by location + IP).
    """

    country_codes: Sequence[str] | None = None
    cities: Sequence[str] | None = None
    ip_include: Sequence[str] | None = None
    ip_exclude: Sequence[str] | None = None
    hostnames: Sequence[str] | None = None

    def is_active(self) -> bool:
        return bool(
            self.country_codes
            or self.cities
            or self.ip_include
            or self.ip_exclude
            or self.hostnames
        )

    @property
    def forces_raw(self) -> bool:
        """True when the query cannot be served from any CAGG."""
        return bool(self.hostnames)

    def sql_conditions(self, events_alias: str, locations_alias: str) -> tuple[str, dict]:
        """WHERE-clause fragment (leading ``AND``) plus bound params.

        ``events_alias`` is the geo_events (or ip_location_daily_stats)
        alias carrying ip_address/hostname; ``locations_alias`` the joined
        geo_locations alias. IP lists are cast to inet[] so asyncpg binds
        them correctly; callers must have validated the IPs first.
        """
        clauses: list[str] = []
        params: dict = {}
        if self.country_codes:
            clauses.append(f"AND {locations_alias}.country_code = ANY(:filter_countries)")
            params["filter_countries"] = [c.upper() for c in self.country_codes]
        if self.cities:
            clauses.append(f"AND {locations_alias}.city = ANY(:filter_cities)")
            params["filter_cities"] = list(self.cities)
        if self.ip_include:
            clauses.append(f"AND {events_alias}.ip_address = ANY(CAST(:filter_ips AS inet[]))")
            params["filter_ips"] = list(self.ip_include)
        if self.ip_exclude:
            clauses.append(
                f"AND NOT ({events_alias}.ip_address = ANY(CAST(:filter_ips_excl AS inet[])))"
            )
            params["filter_ips_excl"] = list(self.ip_exclude)
        if self.hostnames:
            clauses.append(f"AND {events_alias}.hostname = ANY(:filter_hostnames)")
            params["filter_hostnames"] = list(self.hostnames)
        return " ".join(clauses), params
