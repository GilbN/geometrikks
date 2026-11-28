"""AccessLog API endpoints."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from ipaddress import IPv4Network, IPv6Network
from typing import Annotated, cast

from advanced_alchemy.extensions.litestar.providers import create_service_dependencies
from advanced_alchemy.filters import (
    CollectionFilter,
    FilterGroup,
    FilterTypes,
    NotInCollectionFilter,
    NullFilter,
    OnBeforeAfter,
)
from advanced_alchemy.service import OffsetPagination
from litestar import Controller, Request, get
from litestar.datastructures import ResponseHeader
from litestar.di import NamedDependency, Provide
from litestar.exceptions import NotFoundException
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import PathParameter, QueryParameter, SkipValidation
from litestar.status_codes import HTTP_404_NOT_FOUND
from sqlalchemy import or_

from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.domain.logs.dtos import AccessLogDTO
from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.schemas import AccessLogFacets, FilterValueMatches
from geometrikks.domain.logs.services import AccessLogService
from geometrikks.domain.logs.sorting import nulls_last_for_timings
from geometrikks.domain.logs.window_headers import (
    RANGE_HEADERS_STATE_KEY,
    AccessLogRangeHeaders,
)
from geometrikks.domain.muted_ips.dependencies import provide_muted_networks
from geometrikks.domain.muted_ips.filters import MutedNetworksFilter
from geometrikks.lib.ip_filters import (
    IpMatchFilter,
    ip_match_filter,
    validate_ip_filter,
)
from geometrikks.lib.pagination import (
    LIMIT_OFFSET_KEY,
    MAX_LOG_PAGE_SIZE,
    ORDER_BY_KEY,
    limit_offset_provider,
    order_by_provider,
)
from geometrikks.lib.parameters import (
    CITY_FILTER_DESCRIPTION,
    COUNTRY_FILTER_DESCRIPTION,
    REPEAT_NOTE,
    AsnIn,
    AsnNotIn,
    IpAddressIn,
    IpAddressNotIn,
    ServerIn,
    ServerNotIn,
    range_end_examples,
    range_start_examples,
)
from geometrikks.lib.time_ranges import Window, relative_range
from geometrikks.server.exceptions import ErrorEnvelope

ACCESS_LOG_SORT_FIELDS = (
    "timestamp",
    "id",
    "ip_address",
    "remote_user",
    "method",
    "url",
    "http_version",
    "status_code",
    "bytes_sent",
    "referrer",
    "user_agent",
    "request_time",
    "upstream_response_time",
    "host",
    "country_code",
    "country_name",
    "city",
    "autonomous_system_number",
    "autonomous_system_organization",
    "server",
    "log_format",
)


@dataclass(frozen=True)
class AccessLogTimeWindow:
    """The existing inclusive log filters and their resolved bounds."""

    filters: list[FilterTypes]
    start: datetime | None
    end: datetime | None


def provide_access_log_time_window(
    from_timestamp: Annotated[
        datetime | None,
        QueryParameter(
            name="fromTimestamp",
            description="Keep only lines logged at or after this time, as ISO 8601 with a timezone.",
            required=False,
            examples=range_start_examples(),
        ),
    ] = None,
    to_timestamp: Annotated[
        datetime | None,
        QueryParameter(
            name="toTimestamp",
            description="Keep only lines logged at or before this time, as ISO 8601 with a timezone.",
            required=False,
            examples=range_end_examples(),
        ),
    ] = None,
    window: Window = None,
) -> AccessLogTimeWindow:
    """Optional inclusive [from, to] window on the ``timestamp`` column.

    The built-in ``created_at`` / ``updated_at`` filter config targets those
    audit columns; access logs carry the event time on ``timestamp`` instead.
    """
    if window is not None:
        if from_timestamp is not None or to_timestamp is not None:
            raise DomainValidationError("Use window or explicit timestamp bounds, not both.", code="invalid_range")
        resolved = relative_range(window)
        from_timestamp, to_timestamp = resolved.start, resolved.end
    if from_timestamp is None and to_timestamp is None:
        return AccessLogTimeWindow([], None, None)
    return AccessLogTimeWindow([
        OnBeforeAfter(
            field_name="timestamp",
            on_or_after=from_timestamp,
            on_or_before=to_timestamp,
        )
    ], from_timestamp, to_timestamp)


def provide_access_log_in_filters(
    method_in: Annotated[
        list[str] | None,
        QueryParameter(
            name="methodIn",
            description=f"Keep only these HTTP methods, matched exactly, such as `GET`. {REPEAT_NOTE}",
            required=False,
        ),
    ] = None,
    ip_address_in: IpAddressIn = None,
    city_in: Annotated[
        list[str] | None, QueryParameter(name="cityIn", description=CITY_FILTER_DESCRIPTION, required=False)
    ] = None,
    country_code_in: Annotated[
        list[str] | None,
        QueryParameter(name="countryCodeIn", description=COUNTRY_FILTER_DESCRIPTION, required=False),
    ] = None,
    status_in: Annotated[
        list[int] | None,
        QueryParameter(
            name="statusIn",
            description=f"Keep only these HTTP status codes, such as `404`. {REPEAT_NOTE}",
            required=False,
        ),
    ] = None,
    ip_address_not_in: IpAddressNotIn = None,
    host_in: Annotated[
        list[str] | None,
        QueryParameter(
            name="hostIn",
            description=f"Keep only these Host header values, matched exactly, such as `example.com`. {REPEAT_NOTE}",
            required=False,
        ),
    ] = None,
    host_not_in: Annotated[
        list[str] | None,
        QueryParameter(
            name="hostNotIn",
            description=(
                f"Leave out these Host header values, matched exactly. {REPEAT_NOTE} Lines without a host stay in."
            ),
            required=False,
        ),
    ] = None,
    server_in: ServerIn = None,
    server_not_in: ServerNotIn = None,
    log_format_in: Annotated[
        list[str] | None,
        QueryParameter(
            name="logFormatIn",
            description=(
                f"Keep only lines read with these log formats, as `/facets` lists them, such as `nginx`. {REPEAT_NOTE}"
            ),
            required=False,
        ),
    ] = None,
    asn_in: AsnIn = None,
    asn_not_in: AsnNotIn = None,
) -> list[FilterTypes]:
    """Include/exclude matches on method / IP / city / country / status / host / server / log format / ASN.

    Provided here rather than via the built-in ``in_fields`` config, whose
    generated providers yield ``None`` when the param is absent and fail the
    aggregating ``filters`` dependency's object validation.

    Host matching is exact on both sides. The filter bar's include control
    picks from the ``/facets`` host list; exclude is free text, still matched
    exactly (a typo excludes nothing). ``hostNotIn`` is OR'd
    with ``host IS NULL`` because ``host`` is nullable and SQL evaluates
    ``NULL NOT IN (...)`` as NULL rather than TRUE - a bare NOT IN would
    silently drop every row whose host never parsed. ``ip_address`` is
    NOT NULL, so ``ipAddressNotIn`` needs no such treatment. ``server`` is
    nullable for the same reason ``host`` is (older rows predate the
    column), so ``serverNotIn`` gets the same NULL-OR treatment, and so does
    ``asnNotIn``: rows ingested without the ASN database carry no ASN.

    Raises:
        DomainValidationError: If an ``ipAddressIn``/``ipAddressNotIn`` value
            is not an IP or a CIDR range starting on its network address.
    """
    result: list[FilterTypes] = []
    if method_in:
        result.append(CollectionFilter(field_name="method", values=method_in))
    if ip_address_in:
        validate_ip_filter(ip_address_in)
        result.append(ip_match_filter(ip_address_in))
    if city_in:
        result.append(CollectionFilter(field_name="city", values=city_in))
    if country_code_in:
        result.append(CollectionFilter(field_name="country_code", values=country_code_in))
    if status_in:
        result.append(CollectionFilter(field_name="status_code", values=status_in))
    if ip_address_not_in:
        validate_ip_filter(ip_address_not_in)
        result.append(ip_match_filter(ip_address_not_in, exclude=True))
    if host_in:
        result.append(CollectionFilter(field_name="host", values=host_in))
    if host_not_in:
        result.append(
            FilterGroup(
                logical_operator=or_,
                filters=[
                    NotInCollectionFilter(field_name="host", values=host_not_in),
                    NullFilter(field_name="host"),
                ],
            )
        )
    if server_in:
        result.append(CollectionFilter(field_name="server", values=server_in))
    if server_not_in:
        result.append(
            FilterGroup(
                logical_operator=or_,
                filters=[
                    NotInCollectionFilter(field_name="server", values=server_not_in),
                    NullFilter(field_name="server"),
                ],
            )
        )
    if log_format_in:
        result.append(CollectionFilter(field_name="log_format", values=log_format_in))
    if asn_in:
        result.append(CollectionFilter(field_name="autonomous_system_number", values=asn_in))
    if asn_not_in:
        result.append(
            FilterGroup(
                logical_operator=or_,
                filters=[
                    NotInCollectionFilter(field_name="autonomous_system_number", values=asn_not_in),
                    NullFilter(field_name="autonomous_system_number"),
                ],
            )
        )
    return result


async def provide_in_filters(
    base_in_filters: NamedDependency[SkipValidation[list[FilterTypes]]],
    muted_networks: NamedDependency[SkipValidation[list[IPv4Network | IPv6Network] | None]],
) -> list[FilterTypes]:
    """Adds the muted list to the IN filters, unless the request names an IP to include."""
    if muted_networks is None or any(
        isinstance(item, IpMatchFilter) and not item.exclude for item in base_in_filters
    ):
        return base_in_filters
    return cast(list[FilterTypes], [*base_in_filters, MutedNetworksFilter(muted_networks)])


class AccessLogController(Controller):
    """Access log endpoints

    Handles read operations for access logs with filtering, search, sorting,
    and pagination.
    """
    path = "/access-logs"
    return_dto = AccessLogDTO
    tags = ["Access Logs"]

    dependencies = create_service_dependencies(
        AccessLogService,
        key="access_log_service",
        # No config here: constructing it needs Settings(), which must not run
        # at import time. The service provider falls back to the request-scoped
        # ``db_session`` dependency registered by SQLAlchemyInitPlugin.
        # pagination_type and sort_field are kept so the aggregate ``filters``
        # asks for the two providers replaced below, which cap pageSize and
        # check orderBy.
        filters={
            "pagination_type": "limit_offset",
            "search": "url,referrer,user_agent",  # -> ?searchString
            "search_ignore_case": True,
            "sort_field": "timestamp",
        },
    ) | {
        LIMIT_OFFSET_KEY: limit_offset_provider(default_size=50, max_size=MAX_LOG_PAGE_SIZE),
        ORDER_BY_KEY: order_by_provider(
            fields=ACCESS_LOG_SORT_FIELDS,
            default="timestamp",
            note="A sort by `request_time` or `upstream_response_time` puts lines without a timing last.",
        ),
        "time_window": Provide(provide_access_log_time_window, sync_to_thread=False),
        "base_in_filters": Provide(provide_access_log_in_filters, sync_to_thread=False),
        "in_filters": Provide(provide_in_filters),
        "muted_networks": Provide(provide_muted_networks),
    }

    @get(
        "/",
        summary="List access log lines",
        middleware=[AccessLogRangeHeaders()],
        description=(
            "Returns parsed access log lines, newest first, paged with `currentPage` and `pageSize` and sorted "
            "with `orderBy` and `sortOrder`. `searchString` matches part of the URL, referrer or user agent, "
            "ignoring case unless `searchIgnoreCase` is false. Timings are in seconds, and lines go back "
            "ANALYTICS_RAW_RETENTION_DAYS days, 180 by default."
            " For recent polling, use window=10m and deduplicate by id. X-Range-Start and X-Range-End "
            "echo inclusive bounds; reuse them as fromTimestamp and toTimestamp on later pages. "
            "Do not send window with explicit bounds. Pagination is not a snapshot; overlapping polls "
            "can repeat records and do not guarantee late imports or backfills."
        ),
        response_headers=[
            ResponseHeader(name="Cache-Control", value="no-store"),
            ResponseHeader(
                name="X-Range-Start", documentation_only=True,
                description="Inclusive resolved lower bound, when supplied, as ISO 8601.",
            ),
            ResponseHeader(
                name="X-Range-End", documentation_only=True,
                description="Inclusive resolved upper bound, when supplied, as ISO 8601.",
            ),
        ],
    )
    async def list_access_logs(
        self,
        request: Request,
        access_log_service: NamedDependency[AccessLogService],
        filters: NamedDependency[SkipValidation[list[FilterTypes]]],
        time_window: NamedDependency[SkipValidation[AccessLogTimeWindow]],
        in_filters: NamedDependency[SkipValidation[list[FilterTypes]]],
    ) -> OffsetPagination[AccessLog]:
        """List access logs newest-first, with optional search/filter/sort."""
        all_filters = nulls_last_for_timings([*filters, *time_window.filters, *in_filters])
        results, total = await access_log_service.get_many_and_count(*all_filters)
        headers = {}
        if time_window.start is not None:
            headers["X-Range-Start"] = time_window.start.isoformat().replace("+00:00", "Z")
        if time_window.end is not None:
            headers["X-Range-End"] = time_window.end.isoformat().replace("+00:00", "Z")
        request.state[RANGE_HEADERS_STATE_KEY] = headers
        return access_log_service.to_schema(results, total, filters=all_filters)

    @get(
        "/{log_id:int}",
        summary="Get one access log line",
        description=(
            "Returns one parsed access log line by its `id` and its `timestamp`, as the list returns them. "
            "Lines are stored by time, so the timestamp is part of the line's key. Muted IPs are not hidden here."
        ),
        responses={
            HTTP_404_NOT_FOUND: ResponseSpec(
                data_container=ErrorEnvelope,
                description="No line has this id at this time, or retention removed it.",
            ),
        },
    )
    async def get_access_log(
        self,
        access_log_service: NamedDependency[AccessLogService],
        log_id: Annotated[int, PathParameter(description="The line's `id`.")],
        at: Annotated[
            datetime,
            QueryParameter(description="The line's `timestamp`, as ISO 8601 with a timezone."),
        ],
    ) -> AccessLog:
        """One line by id and time, for a link to its record."""
        line = await access_log_service.get_line(log_id, at)
        if line is None:
            raise NotFoundException(detail=f"No access log line {log_id} at {at.isoformat()}")
        return line

    @get(
        "/facets",
        return_dto=None,
        summary="List the filter values in the access logs",
        description=(
            "Returns every country, city, host, server name, log format and ASN the access logs hold, to fill the "
            "list filters. It reads the daily aggregates, so values stay listed after their raw lines are gone."
        ),
    )
    async def get_access_log_facets(
        self,
        access_log_service: NamedDependency[AccessLogService],
    ) -> AccessLogFacets:
        """Distinct country/city/host/server/log-format values, for filter dropdowns.

        ``return_dto=None`` opts out of the controller-level ``AccessLogDTO``
        (bound to the AccessLog model); Litestar serializes the structs
        directly, and ``AccessLogFacets`` carries its own ``rename="camel"``
        (``log_formats`` goes out as ``logFormats``).
        """
        return await access_log_service.get_facets()

    @get(
        "/facets/search",
        return_dto=None,
        summary="Search the filter values by name",
        description=(
            "Returns the countries, cities, hosts, server names and ASNs whose name holds `q`, ignoring case "
            "and accents, busiest first, up to `limit` of each. A country also matches its two-letter code, and "
            "an ASN matches its number with or without `AS`, from the first digits. Totals cover everything the "
            "daily aggregates keep, muted IPs included, and can trail new requests by up to five minutes."
        ),
    )
    async def search_access_log_facets(
        self,
        access_log_service: NamedDependency[AccessLogService],
        q: Annotated[
            str,
            QueryParameter(description="The text to look for, 2 to 100 characters.", min_length=2, max_length=100),
        ],
        limit: Annotated[
            int,
            QueryParameter(description="How many values of each kind to return, from 1 to 20. Defaults to 4.", ge=1, le=20),
        ] = 4,
    ) -> FilterValueMatches:
        """Name search over the filter values, for the command palette."""
        return await access_log_service.search_filter_values(q, limit)
