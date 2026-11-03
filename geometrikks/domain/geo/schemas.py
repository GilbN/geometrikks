"""Bespoke response schemas and filters for the geo-logs endpoints.

msgspec Structs with camelCase renaming (litestar-recommended style for new
code). Required fields are deliberately default-less: defaults would make
them non-required in OpenAPI, which turns into optional fields in the
generated TS client.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Sequence

import msgspec

from geometrikks.domain.analytics.asn_classification import ASN_CATEGORY_DESCRIPTION, AsnCategory

EchoedFrom = Annotated[str, msgspec.Meta(description="The request's `fromTimestamp`, echoed as ISO 8601.")]
EchoedTo = Annotated[str, msgspec.Meta(description="The request's `toTimestamp`, echoed as ISO 8601.")]
AsnOrganization = Annotated[
    str | None,
    msgspec.Meta(description="The network's name from the GeoLite2 ASN database. Null when it has none."),
]
DistinctIps = Annotated[int, msgspec.Meta(description="Distinct client IPs among the events.")]


class GeoLogEntry(msgspec.Struct, rename="camel"):
    """The events from one IP at one location in the range."""

    location_id: Annotated[int, msgspec.Meta(description="The location's `id`, as `/api/v1/geo-locations` lists it.")]
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
    last_seen: Annotated[
        datetime | None,
        msgspec.Meta(
            description=(
                "The time of the last event. On ranges over 24 hours it can be the start of the hour or UTC "
                "day that held it."
            )
        ),
    ]
    asn: int | None
    as_organization: AsnOrganization
    # Aggregates written before server tracking have no server sets until the
    # CLI backfill runs, and history past raw retention cannot get them back.
    servers: Annotated[
        list[str],
        msgspec.Meta(
            description=(
                "The servers that recorded these events, sorted by name. Older aggregated history can lack "
                "server data, so on ranges over 24 hours this can be incomplete or empty."
            )
        ),
    ]


class GeoLogPeriod(msgspec.Struct, rename="camel"):
    """Geo event totals for one period."""

    total_events: int
    unique_ips: int
    unique_countries: int
    unique_cities: int


class GeoLogPercentChange(msgspec.Struct, rename="camel"):
    """The percent change of each figure from the previous period.

    25.0 means a rise of a quarter. A figure is null when its previous value is 0.
    """

    total_events: float | None
    unique_ips: float | None
    unique_countries: float | None
    unique_cities: float | None


class GeoLogSummaryResponse(msgspec.Struct, rename="camel"):
    """Geo event totals for a time range, and optionally for the period of the same length before it."""

    start_date: EchoedFrom
    end_date: EchoedTo
    current_period: GeoLogPeriod
    previous_period: Annotated[
        GeoLogPeriod | None,
        msgspec.Meta(description="Null unless `comparePrevious` is true and the previous period has events."),
    ]
    percent_changes: Annotated[
        GeoLogPercentChange | None, msgspec.Meta(description="Null whenever `previousPeriod` is null.")
    ]


class GeoLogTimeSeriesPoint(msgspec.Struct, rename="camel"):
    """Geo events and unique IPs for one bucket."""

    timestamp: Annotated[datetime, msgspec.Meta(description="The bucket start, in UTC.")]
    total_events: int
    unique_ips: int


class GeoLogTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Geo events and unique IPs per bucket, oldest first. Buckets without events are left out."""

    granularity: Annotated[str, msgspec.Meta(description="The bucket size used, `hourly` or `daily`.")]
    start_date: EchoedFrom
    end_date: EchoedTo
    data: list[GeoLogTimeSeriesPoint]


class TopGeoIp(msgspec.Struct, rename="camel"):
    """One client IP with its geo events across every location."""

    ip_address: str
    event_count: int
    country_code: Annotated[
        str | None, msgspec.Meta(description="One of the IP's countries when it has events in several.")
    ]
    city: Annotated[str | None, msgspec.Meta(description="One of the IP's cities when it has events in several.")]
    asn: int | None
    as_organization: AsnOrganization


class TopGeoIpsResponse(msgspec.Struct, rename="camel"):
    """Client IPs ordered by geo event count, most first."""

    items: list[TopGeoIp]


class TopGeoCountry(msgspec.Struct, rename="camel"):
    """One country with its geo events."""

    country_code: str
    country_name: str | None
    event_count: int
    unique_ips: DistinctIps


class TopGeoCountriesResponse(msgspec.Struct, rename="camel"):
    """Countries ordered by geo event count, most first."""

    items: list[TopGeoCountry]


class TopGeoCity(msgspec.Struct, rename="camel"):
    """One city with its geo events."""

    city: str
    country_code: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "A country with a city of this name in the range. Cities with the same name in different "
                "countries share one row."
            )
        ),
    ]
    event_count: int
    unique_ips: DistinctIps


class TopGeoCitiesResponse(msgspec.Struct, rename="camel"):
    """Cities ordered by geo event count, most first."""

    items: list[TopGeoCity]


class TopGeoAsn(msgspec.Struct, rename="camel"):
    """One autonomous system with its geo events."""

    asn: int
    organization: AsnOrganization
    category: Annotated[AsnCategory, msgspec.Meta(description=ASN_CATEGORY_DESCRIPTION)]
    event_count: int
    unique_ips: DistinctIps


class TopGeoAsnsResponse(msgspec.Struct, rename="camel"):
    """Autonomous systems ordered by geo event count, most first."""

    items: list[TopGeoAsn]


class GeoAsnFacet(msgspec.Struct, rename="camel"):
    """One autonomous system in the stored data."""

    asn: int
    organization: AsnOrganization


class GeoCountryFacet(msgspec.Struct, rename="camel"):
    """One country in the stored data."""

    code: Annotated[str, msgspec.Meta(description="The two-letter ISO 3166-1 code, the value `countryCodeIn` takes.")]
    name: Annotated[str, msgspec.Meta(description="The country name, or the code when GeoIP gives no name.")]


class GeoEventFacets(msgspec.Struct, rename="camel"):
    """The values the geo event filters accept, as found in the stored data."""

    countries: Annotated[list[GeoCountryFacet], msgspec.Meta(description="Sorted by name.")]
    cities: Annotated[list[str], msgspec.Meta(description="Sorted by name.")]
    servers: Annotated[list[str], msgspec.Meta(description="Sorted by name.")]
    asns: Annotated[
        list[GeoAsnFacet],
        msgspec.Meta(description="Sorted by organization, with the ones that have none last."),
    ]


@dataclass
class GeoEventFilters:
    """Optional dimension filters for geo-event aggregate queries.

    Server filtering forces the raw geo_events path, because per-IP CAGGs
    store server sets, not per-server counts. Every other filter, ASN included, works on the CAGG
    paths too (the per-IP CAGGs are keyed by location + IP and carry the
    IP's ASN).
    """

    country_codes: Sequence[str] | None = None
    cities: Sequence[str] | None = None
    ip_include: Sequence[str] | None = None
    ip_exclude: Sequence[str] | None = None
    servers: Sequence[str] | None = None
    asn_include: Sequence[int] | None = None
    asn_exclude: Sequence[int] | None = None

    def is_active(self) -> bool:
        return bool(
            self.country_codes
            or self.cities
            or self.ip_include
            or self.ip_exclude
            or self.servers
            or self.asn_include
            or self.asn_exclude
        )

    @property
    def forces_raw(self) -> bool:
        """True when the query cannot be served from any CAGG."""
        return bool(self.servers)

    def sql_conditions(
        self,
        events_alias: str,
        locations_alias: str,
        *,
        asn_column: str = "autonomous_system_number",
    ) -> tuple[str, dict]:
        """WHERE-clause fragment (leading ``AND``) plus bound params.

        ``events_alias`` is the geo_events (or stitched ``combined``) alias
        carrying ip_address/server; ``locations_alias`` the joined
        geo_locations alias. ``asn_column`` is the ASN column on
        ``events_alias``: ``autonomous_system_number`` on raw geo_events,
        ``asn`` on ``combined``. IP lists are cast to inet[] so asyncpg binds
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
        if self.servers:
            clauses.append(f"AND {events_alias}.server = ANY(:filter_servers)")
            params["filter_servers"] = list(self.servers)
        asn = f"{events_alias}.{asn_column}"
        if self.asn_include:
            clauses.append(f"AND {asn} = ANY(CAST(:filter_asns AS bigint[]))")
            params["filter_asns"] = [int(a) for a in self.asn_include]
        if self.asn_exclude:
            # NOT (NULL = ANY(...)) is NULL, which would drop every row
            # without ASN data from an exclude; keep them explicitly.
            clauses.append(
                f"AND ({asn} IS NULL OR NOT ({asn} = ANY(CAST(:filter_asns_excl AS bigint[]))))"
            )
            params["filter_asns_excl"] = [int(a) for a in self.asn_exclude]
        return " ".join(clauses), params
