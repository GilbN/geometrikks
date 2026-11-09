"""GeoEvent API endpoints (raw events + geo-logs page aggregates)."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import QueryParameter, SkipValidation
from advanced_alchemy.extensions.litestar.providers import create_service_dependencies
from advanced_alchemy.filters import (
    CollectionFilter,
    FilterTypes,
    NotInCollectionFilter,
    OnBeforeAfter,
)
from advanced_alchemy.service import OffsetPagination

from geometrikks.domain.drop.dependencies import provide_drop_snapshot
from geometrikks.domain.drop.snapshot import DropSnapshot
from geometrikks.domain.geo.models import GeoEvent
from geometrikks.domain.geo.dtos import GeoEventDTO
from geometrikks.domain.geo.repositories import StatsGranularity, get_stats_granularity
from geometrikks.domain.geo.schemas import (
    GeoEventFacets,
    GeoEventFilters,
    GeoLogEntry,
    GeoLogPercentChange,
    GeoLogSummaryResponse,
    GeoLogTimeSeriesResponse,
    TopGeoAsnsResponse,
    TopGeoCitiesResponse,
    TopGeoCountriesResponse,
    TopGeoIpsResponse,
)
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.lib.parameters import (
    range_end_examples,
    range_start_examples,
    CITY_FILTER_DESCRIPTION,
    COUNTRY_FILTER_DESCRIPTION,
    ChartGranularity,
    ComparePrevious,
    ToTimestamp,
    AsnIn,
    AsnNotIn,
    ServerIn,
    IpAddressIn,
    IpAddressNotIn,
    FromTimestamp,
    GEO_WHOLE_BUCKETS_NOTE,
    Timezone,
    local_days_edge_note,
)
from geometrikks.lib.pagination import (
    LIMIT_OFFSET_KEY,
    MAX_PAGE_SIZE,
    ORDER_BY_KEY,
    limit_offset_provider,
    order_by_provider,
)
from geometrikks.lib.time import ensure_utc
from geometrikks.lib.validation import validate_ip_addresses, validate_timezone

GEO_EVENT_SORT_FIELDS = (
    "timestamp",
    "id",
    "ip_address",
    "server",
    "location_id",
    "autonomous_system_number",
    "autonomous_system_organization",
)


def _calculate_percent_change(current: float, previous: float) -> float | None:
    """Percent change between two values (None when previous is 0)."""
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


def provide_geo_event_time_window(
    from_timestamp: Annotated[
        datetime | None,
        QueryParameter(
            name="fromTimestamp",
            description="Keep only events at or after this time, as ISO 8601 with a timezone.",
            required=False,
            examples=range_start_examples(),
        ),
    ] = None,
    to_timestamp: Annotated[
        datetime | None,
        QueryParameter(
            name="toTimestamp",
            description="Keep only events at or before this time, as ISO 8601 with a timezone.",
            required=False,
            examples=range_end_examples(),
        ),
    ] = None,
) -> list[FilterTypes]:
    """Optional inclusive [from, to] window on the ``timestamp`` column.

    The built-in ``created_at`` / ``updated_at`` filter config targets those
    audit columns; geo events carry the event time on ``timestamp`` instead.
    """
    if from_timestamp is None and to_timestamp is None:
        return []
    return [
        OnBeforeAfter(
            field_name="timestamp",
            on_or_after=ensure_utc(from_timestamp) if from_timestamp is not None else None,
            on_or_before=ensure_utc(to_timestamp) if to_timestamp is not None else None,
        )
    ]


def provide_geo_event_in_filters(
    ip_address_in: IpAddressIn = None,
    ip_address_not_in: IpAddressNotIn = None,
    server_in: ServerIn = None,
) -> list[FilterTypes]:
    """IP include/exclude and server ``IN`` filters for the raw event list.

    Provided here rather than via the built-in ``in_fields`` config, whose
    generated providers yield ``None`` when the param is absent and fail the
    aggregating ``filters`` dependency's object validation.
    """
    result: list[FilterTypes] = []
    if ip_address_in:
        validate_ip_addresses(ip_address_in)
        result.append(CollectionFilter(field_name="ip_address", values=ip_address_in))
    if ip_address_not_in:
        validate_ip_addresses(ip_address_not_in)
        result.append(NotInCollectionFilter(field_name="ip_address", values=ip_address_not_in))
    if server_in:
        result.append(CollectionFilter(field_name="server", values=server_in))
    return result


def provide_geo_event_filters(
    country_code_in: Annotated[
        list[str] | None,
        QueryParameter(name="countryCodeIn", description=COUNTRY_FILTER_DESCRIPTION, required=False),
    ] = None,
    city_in: Annotated[
        list[str] | None, QueryParameter(name="cityIn", description=CITY_FILTER_DESCRIPTION, required=False)
    ] = None,
    ip_address_in: IpAddressIn = None,
    ip_address_not_in: IpAddressNotIn = None,
    server_in: ServerIn = None,
    asn_in: AsnIn = None,
    asn_not_in: AsnNotIn = None,
) -> GeoEventFilters:
    """Dimension filters consumed by the aggregate endpoints."""
    if ip_address_in:
        validate_ip_addresses(ip_address_in)
    if ip_address_not_in:
        validate_ip_addresses(ip_address_not_in)
    return GeoEventFilters(
        country_codes=country_code_in or None,
        cities=city_in or None,
        ip_include=ip_address_in or None,
        ip_exclude=ip_address_not_in or None,
        servers=server_in or None,
        asn_include=asn_in or None,
        asn_exclude=asn_not_in or None,
    )


def _resolve_chart_granularity(
    start: datetime, end: datetime, override: str | None
) -> StatsGranularity:
    """Chart bucket granularity: explicit override wins, else auto-route.

    Only "hourly"/"daily" are accepted from the API, so RAW can never be
    requested; the auto fallback clamps RAW to HOURLY (no raw CAGG exists,
    hourly + real-time aggregation covers <= 24h ranges).
    """
    if override is not None:
        return StatsGranularity(override)
    granularity = get_stats_granularity(start, end)
    if granularity == StatsGranularity.RAW:
        granularity = StatsGranularity.HOURLY
    return granularity


SERVER_FILTER_RAW_NOTE = (
    "A server filter reads the raw rows, which go back only ANALYTICS_RAW_RETENTION_DAYS days, 180 by default."
)


class GeoEventController(Controller):
    """Geo-event endpoints: raw event listing and geo-logs page aggregates.

    Perf note: only server filters force raw geo_events scans for
    summary/time-series (per-IP CAGGs have no per-server counts); those
    queries are bounded by raw_retention_days (default 180d). Country/city/IP
    filters ride the stitched per-IP CAGGs instead.
    """

    path = "/geo-events"
    return_dto = GeoEventDTO
    tags = ["Geo Events"]

    dependencies = create_service_dependencies(
        GeoEventService,
        key="geo_event_service",
        # No config here: constructing it needs Settings(), which must not run
        # at import time. The service provider falls back to the request-scoped
        # ``db_session`` dependency registered by SQLAlchemyInitPlugin.
        # Kept so the aggregate ``filters`` asks for the two providers
        # replaced below, which cap pageSize and check orderBy.
        filters={"pagination_type": "limit_offset", "sort_field": "timestamp"},
    ) | {
        LIMIT_OFFSET_KEY: limit_offset_provider(default_size=50),
        ORDER_BY_KEY: order_by_provider(fields=GEO_EVENT_SORT_FIELDS, default="timestamp"),
        "time_window": Provide(provide_geo_event_time_window, sync_to_thread=False),
        "in_filters": Provide(provide_geo_event_in_filters, sync_to_thread=False),
        "geo_filters": Provide(provide_geo_event_filters, sync_to_thread=False),
        "drop_snapshot": Provide(provide_drop_snapshot),
    }

    @get(
        "/",
        summary="List geo events",
        description=(
            "Returns one event per logged request whose client IP has a GeoIP location, newest first, with "
            "the location embedded. Page with `currentPage` and `pageSize`, and sort with `orderBy` and "
            "`sortOrder`. `fromTimestamp` and `toTimestamp` are optional here, and both ends of the range are "
            "inclusive."
        ),
    )
    async def list_geo_events(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        filters: NamedDependency[SkipValidation[list[FilterTypes]]],
        time_window: NamedDependency[SkipValidation[list[FilterTypes]]],
        in_filters: NamedDependency[SkipValidation[list[FilterTypes]]],
    ) -> OffsetPagination[GeoEvent]:
        """List raw geo events newest-first, with optional filters."""
        all_filters = [*filters, *time_window, *in_filters]
        results, total = await geo_event_service.get_many_and_count(*all_filters)
        return geo_event_service.to_schema(results, total, filters=all_filters)

    @get(
        "/logs",
        return_dto=None,
        summary="List geo events grouped by location and IP",
        description=(
            "Returns one row per location and IP pair with its event count, last event, ASN and the servers "
            "that recorded it, paged with `currentPage` and `pageSize`. Rows with a null sort value come last "
            "in both directions. Ranges over 24 hours read the per-IP aggregates, so `lastSeen` can be the "
            f"start of the hour or UTC day of the last event. {SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_logs(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        current_page: Annotated[
            int,
            QueryParameter(
                name="currentPage",
                description="The page to return, counted from 1. Defaults to 1.",
                ge=1,
                required=False,
            ),
        ] = 1,
        page_size: Annotated[
            int,
            QueryParameter(
                name="pageSize",
                description=f"Rows per page, from 1 to {MAX_PAGE_SIZE}. Defaults to 50.",
                ge=1,
                le=MAX_PAGE_SIZE,
                required=False,
            ),
        ] = 50,
        order_by: Annotated[
            str,
            QueryParameter(
                name="orderBy",
                description=(
                    "The column to sort by: `event_count`, `last_seen`, `ip_address`, `city`, `postal_code`, "
                    "`state`, `country_code`, `country_name`, `latitude`, `longitude` or `asn`. Defaults to "
                    "`event_count`. Any other value gets a 400."
                ),
                required=False,
            ),
        ] = "event_count",
        sort_order: Annotated[
            Literal["asc", "desc"],
            QueryParameter(name="sortOrder", description="`asc` or `desc`. Defaults to `desc`.", required=False),
        ] = "desc",
    ) -> OffsetPagination[GeoLogEntry]:
        """One row per (location, IP) pair, sorted by event count by default.

        Ranges > 24h are served from the daily per-IP CAGG (day-floored
        buckets, distinct servers); a server filter forces the raw path.
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)
        limit = page_size
        offset = page_size * (current_page - 1)
        rows, total = await geo_event_service.get_grouped_logs(
            from_timestamp, to_timestamp, geo_filters,
            limit=limit, offset=offset, order_by=order_by, sort_order=sort_order,
        )
        return OffsetPagination[GeoLogEntry](items=rows, total=total, limit=limit, offset=offset)

    @get(
        "/summary",
        return_dto=None,
        summary="Get geo event totals for a time range",
        description=(
            "Returns the event count and the unique IPs, countries and cities for the range. With "
            "`comparePrevious` it adds the period of the same length that ends at `fromTimestamp`, and both "
            "comparison fields stay null when that period has no events. Unfiltered ranges over 24 hours read "
            f"the hourly or daily aggregates, which {GEO_WHOLE_BUCKETS_NOTE}, and their unique counts are "
            f"estimates. {SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_log_summary(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        compare_previous: ComparePrevious = False,
    ) -> GeoLogSummaryResponse:
        """Totals and unique counts for the period, optionally vs the previous one.

        Server-filtered ranges scan raw geo_events; country/city/IP filters
        use per-IP CAGGs (exact uniques); unfiltered ranges > 24h use HLL
        CAGGs (approximate uniques).
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)
        current = await geo_event_service.get_summary(from_timestamp, to_timestamp, geo_filters)

        previous = None
        percent_changes = None
        if compare_previous:
            period_length = to_timestamp - from_timestamp
            prev_end = from_timestamp
            prev_start = prev_end - period_length
            prev = await geo_event_service.get_summary(prev_start, prev_end, geo_filters)
            if prev.total_events > 0:
                previous = prev
                percent_changes = GeoLogPercentChange(
                    total_events=_calculate_percent_change(current.total_events, prev.total_events),
                    unique_ips=_calculate_percent_change(current.unique_ips, prev.unique_ips),
                    unique_countries=_calculate_percent_change(
                        current.unique_countries, prev.unique_countries
                    ),
                    unique_cities=_calculate_percent_change(
                        current.unique_cities, prev.unique_cities
                    ),
                )

        return GeoLogSummaryResponse(
            start_date=from_timestamp.isoformat(),
            end_date=to_timestamp.isoformat(),
            current_period=current,
            previous_period=previous,
            percent_changes=percent_changes,
        )

    @get(
        "/time-series",
        return_dto=None,
        summary="Get geo events and unique IPs, countries and cities per hour or day",
        description=(
            "Returns events and unique IPs, countries and cities for each bucket that has events, oldest first. "
            f"Unfiltered ranges over 24 hours read the aggregates, which {GEO_WHOLE_BUCKETS_NOTE}, and their "
            f"unique counts are estimates. {local_days_edge_note('fromTimestamp', 'toTimestamp')} A server filter reads the raw "
            "rows, and so does any other filter with hourly buckets on a range over 30 days. Raw reads go back "
            "only ANALYTICS_RAW_RETENTION_DAYS days, 180 by default, and a server filter with daily buckets "
            "applies `tz` at any range length."
        ),
    )
    async def get_geo_log_time_series(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        granularity: ChartGranularity = None,
        tz: Timezone = None,
    ) -> GeoLogTimeSeriesResponse:
        """Bucketed totals and unique IPs, countries and cities.

        Server-filtered ranges scan raw geo_events; country/city/IP filters
        use per-IP CAGGs (exact uniques); unfiltered ranges > 24h use HLL
        CAGGs (approximate uniques).
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)
        resolved = _resolve_chart_granularity(from_timestamp, to_timestamp, granularity)
        if tz is not None:
            validate_timezone(tz)
        points = await geo_event_service.get_time_series(
            from_timestamp, to_timestamp, resolved, geo_filters, tz=tz
        )
        return GeoLogTimeSeriesResponse(
            granularity=resolved.value,
            start_date=from_timestamp.isoformat(),
            end_date=to_timestamp.isoformat(),
            data=points,
        )

    @get(
        "/top-ips",
        return_dto=None,
        summary="List the IPs with the most geo events",
        description=(
            "Returns client IPs ordered by event count across every location, with a country, city and ASN. "
            "For an IP seen in several locations, `countryCode` and `city` each show one of them. "
            f"{SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_log_top_ips(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int, QueryParameter(description="How many IPs to return, from 1 to 50. Defaults to 10.", ge=1, le=50)
        ] = 10,
    ) -> TopGeoIpsResponse:
        """Top IPs across all locations for the period."""
        rows = await geo_event_service.get_top_ips(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoIpsResponse(items=rows)

    @get(
        "/top-countries",
        return_dto=None,
        summary="List the countries with the most geo events",
        description=(
            f"Returns countries ordered by event count, with the distinct IPs from each. {SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_log_top_countries(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int,
            QueryParameter(description="How many countries to return, from 1 to 50. Defaults to 10.", ge=1, le=50),
        ] = 10,
    ) -> TopGeoCountriesResponse:
        """Top countries with exact unique-IP counts for the period."""
        rows = await geo_event_service.get_top_countries(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoCountriesResponse(items=rows)

    @get(
        "/top-cities",
        return_dto=None,
        summary="List the cities with the most geo events",
        description=(
            "Returns cities ordered by event count, with the distinct IPs from each. Events without a city are "
            "left out, and cities with the same name in different countries count as one. "
            f"{SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_log_top_cities(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int, QueryParameter(description="How many cities to return, from 1 to 50. Defaults to 10.", ge=1, le=50)
        ] = 10,
    ) -> TopGeoCitiesResponse:
        """Top cities (NULL cities excluded) for the period."""
        rows = await geo_event_service.get_top_cities(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoCitiesResponse(items=rows)

    @get(
        "/top-asns",
        return_dto=None,
        summary="List the networks with the most geo events",
        description=(
            "Returns autonomous systems ordered by event count, with the distinct IPs and the category of each. "
            f"Events without ASN data are left out. {SERVER_FILTER_RAW_NOTE}"
        ),
    )
    async def get_geo_log_top_asns(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int, QueryParameter(description="How many ASNs to return, from 1 to 50. Defaults to 10.", ge=1, le=50)
        ] = 10,
    ) -> TopGeoAsnsResponse:
        """Top ASNs with exact unique-IP counts; rows without ASN data are excluded."""
        rows = await geo_event_service.get_top_asns(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit,
            drop_snapshot=drop_snapshot,
        )
        return TopGeoAsnsResponse(items=rows)

    @get(
        "/facets",
        return_dto=None,
        summary="List the values the geo event filters accept",
        description=(
            "Returns every country, city, server and ASN in the stored data, to fill filter dropdowns. It takes "
            "no time range, and the values outlast the raw retention."
        ),
    )
    async def get_geo_log_facets(
        self,
        geo_event_service: NamedDependency[GeoEventService],
    ) -> GeoEventFacets:
        """Distinct country/city/server/ASN values present in the geo data."""
        return await geo_event_service.get_facets()
