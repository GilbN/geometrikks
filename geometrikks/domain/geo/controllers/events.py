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
    TopGeoCitiesResponse,
    TopGeoCountriesResponse,
    TopGeoIpsResponse,
)
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.lib.parameters import (
    ToTimestamp,
    HostnameIn,
    IpAddressIn,
    IpAddressNotIn,
    FromTimestamp,
    Timezone,
)
from geometrikks.lib.time import ensure_utc
from geometrikks.lib.validation import validate_ip_addresses, validate_timezone



def _calculate_percent_change(current: float, previous: float) -> float | None:
    """Percent change between two values (None when previous is 0)."""
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


def provide_geo_event_time_window(
    from_timestamp: Annotated[datetime | None, QueryParameter(name="fromTimestamp", required=False)] = None,
    to_timestamp: Annotated[datetime | None, QueryParameter(name="toTimestamp", required=False)] = None,
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
    hostname_in: HostnameIn = None,
) -> list[FilterTypes]:
    """IP include/exclude and hostname ``IN`` filters for the raw event list.

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
    if hostname_in:
        result.append(CollectionFilter(field_name="hostname", values=hostname_in))
    return result


def provide_geo_event_filters(
    country_code_in: Annotated[list[str] | None, QueryParameter(name="countryCodeIn", required=False)] = None,
    city_in: Annotated[list[str] | None, QueryParameter(name="cityIn", required=False)] = None,
    ip_address_in: IpAddressIn = None,
    ip_address_not_in: IpAddressNotIn = None,
    hostname_in: HostnameIn = None,
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
        hostnames=hostname_in or None,
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


class GeoEventController(Controller):
    """Geo-event endpoints: raw event listing and geo-logs page aggregates.

    Perf note: only hostname filters force raw geo_events scans for
    summary/time-series now (no CAGG carries a hostname dimension); those
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
        filters={
            "pagination_type": "limit_offset",   # -> ?currentPage & ?pageSize
            "pagination_size": 50,
            "sort_field": "timestamp",            # default; overridable via ?orderBy
            "sort_order": "desc",                 # -> ?sortOrder
        },
    ) | {
        "time_window": Provide(provide_geo_event_time_window, sync_to_thread=False),
        "in_filters": Provide(provide_geo_event_in_filters, sync_to_thread=False),
        "geo_filters": Provide(provide_geo_event_filters, sync_to_thread=False),
    }

    @get("/")
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

    @get("/logs", return_dto=None, description="Geo events grouped by (location, IP) with counts.")
    async def get_geo_logs(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        current_page: Annotated[int, QueryParameter(name="currentPage", ge=1, required=False)] = 1,
        page_size: Annotated[int, QueryParameter(name="pageSize", ge=1, le=500, required=False)] = 50,
        order_by: Annotated[
            str,
            QueryParameter(
                name="orderBy",
                description="Sort column (snake_case, e.g. event_count, city, "
                "ip_address, last_seen); validated against the service allowlist",
                required=False,
            ),
        ] = "event_count",
        sort_order: Annotated[
            Literal["asc", "desc"],
            QueryParameter(name="sortOrder", description="Sort direction", required=False),
        ] = "desc",
    ) -> OffsetPagination[GeoLogEntry]:
        """One row per (location, IP) pair, sorted by event count by default.

        Ranges > 24h are served from the daily per-IP CAGG (day-floored
        buckets, no hostnames); a hostname filter forces the raw path.
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

    @get("/summary", return_dto=None, description="Aggregate geo-event stats for the stat cards.")
    async def get_geo_log_summary(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        compare_previous: Annotated[
            bool,
            QueryParameter(name="comparePrevious", description="Include comparison with previous period of same length"),
        ] = False,
    ) -> GeoLogSummaryResponse:
        """Totals and unique counts for the period, optionally vs the previous one.

        Hostname-filtered ranges scan raw geo_events; country/city/IP filters
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

    @get("/time-series", return_dto=None, description="Per-bucket geo-event totals for the chart.")
    async def get_geo_log_time_series(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        granularity: Annotated[
            Literal["hourly", "daily"] | None,
            QueryParameter(
                description="Bucket size override. Omit to auto-select "
                "(hourly <= 30 days, daily above). RAW is never available.",
                required=False,
            ),
        ] = None,
        tz: Timezone = None,
    ) -> GeoLogTimeSeriesResponse:
        """Bucketed totals + unique IPs.

        Hostname-filtered ranges scan raw geo_events; country/city/IP filters
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

    @get("/top-ips", return_dto=None, description="Top IPs by geo-event count.")
    async def get_geo_log_top_ips(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[int, QueryParameter(description="Maximum number of IPs", ge=1, le=50)] = 10,
    ) -> TopGeoIpsResponse:
        """Top IPs across all locations for the period."""
        rows = await geo_event_service.get_top_ips(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoIpsResponse(items=rows)

    @get("/top-countries", return_dto=None, description="Top countries by geo-event count.")
    async def get_geo_log_top_countries(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[int, QueryParameter(description="Maximum number of countries", ge=1, le=50)] = 10,
    ) -> TopGeoCountriesResponse:
        """Top countries with exact unique-IP counts for the period."""
        rows = await geo_event_service.get_top_countries(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoCountriesResponse(items=rows)

    @get("/top-cities", return_dto=None, description="Top cities by geo-event count.")
    async def get_geo_log_top_cities(
        self,
        geo_event_service: NamedDependency[GeoEventService],
        geo_filters: NamedDependency[SkipValidation[GeoEventFilters]],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[int, QueryParameter(description="Maximum number of cities", ge=1, le=50)] = 10,
    ) -> TopGeoCitiesResponse:
        """Top cities (NULL cities excluded) for the period."""
        rows = await geo_event_service.get_top_cities(
            ensure_utc(from_timestamp), ensure_utc(to_timestamp), geo_filters, limit=limit
        )
        return TopGeoCitiesResponse(items=rows)

    @get("/facets", return_dto=None, description="Distinct filterable values for dropdowns.")
    async def get_geo_log_facets(
        self,
        geo_event_service: NamedDependency[GeoEventService],
    ) -> GeoEventFacets:
        """Distinct country/city/hostname values present in the geo data."""
        return await geo_event_service.get_facets()
