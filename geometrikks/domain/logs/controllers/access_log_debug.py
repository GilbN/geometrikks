"""AccessLogDebug API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import QueryParameter, SkipValidation
from advanced_alchemy.extensions.litestar.providers import create_service_dependencies
from advanced_alchemy.filters import FilterTypes, LimitOffset, OnBeforeAfter
from advanced_alchemy.service import OffsetPagination

from geometrikks.domain.logs.schemas import AccessLogDebugEntry, AccessLogDebugStats
from geometrikks.domain.logs.services import AccessLogDebugService
from geometrikks.lib.validation import validate_ip_addresses


def provide_debug_time_window(
    from_timestamp: Annotated[datetime | None, QueryParameter(name="fromTimestamp", required=False)] = None,
    to_timestamp: Annotated[datetime | None, QueryParameter(name="toTimestamp", required=False)] = None,
) -> list[FilterTypes]:
    """Optional inclusive [from, to] window on ``created_at`` (ingest time).

    ``created_at`` (not the log's own ``timestamp``) is the hypertable's
    partition column, so this window is what lets Timescale prune chunks.
    """
    if from_timestamp is None and to_timestamp is None:
        return []
    return [
        OnBeforeAfter(
            field_name="created_at",
            on_or_after=from_timestamp,
            on_or_before=to_timestamp,
        )
    ]


def validated_ips(values: list[str] | None) -> list[str] | None:
    """Pass through complete IPs; reject free text with a 400."""
    if not values:
        return None
    validate_ip_addresses(values)
    return values


class AccessLogDebugController(Controller):
    """Access log debug endpoints.

    Read operations for raw/malformed log lines with their denormalized
    access-log context, filtering, search, sorting, and pagination.
    """

    path = "/access-log-debug"
    tags = ["Access Log Debug"]

    dependencies = create_service_dependencies(
        AccessLogDebugService,
        key="access_log_debug_service",
        # No sort config: the generated OrderBy provider cannot resolve the
        # logical ``timestamp`` key, which maps to the log_timestamp column;
        # the handler passes orderBy through to the service's allowlist.
        filters={
            "pagination_type": "limit_offset",   # -> ?currentPage & ?pageSize
            "pagination_size": 50,
            "search": "raw_line,parse_error",    # -> ?searchString
            "search_ignore_case": True,
        },
    ) | {
        "time_window": Provide(provide_debug_time_window, sync_to_thread=False),
    }

    @get("/")
    async def list_access_log_debug(
        self,
        access_log_debug_service: NamedDependency[AccessLogDebugService],
        filters: NamedDependency[SkipValidation[list[FilterTypes]]],
        time_window: NamedDependency[SkipValidation[list[FilterTypes]]],
        ip_address_in: Annotated[
            list[str] | None, QueryParameter(name="ipAddressIn", required=False)
        ] = None,
        country_code_in: Annotated[
            list[str] | None, QueryParameter(name="countryCodeIn", required=False)
        ] = None,
        city_in: Annotated[
            list[str] | None, QueryParameter(name="cityIn", required=False)
        ] = None,
        malformed: Annotated[bool | None, QueryParameter(required=False)] = None,
        order_by: Annotated[
            str, QueryParameter(name="orderBy", required=False)
        ] = "created_at",
        sort_order: Annotated[
            Literal["asc", "desc"], QueryParameter(name="sortOrder", required=False)
        ] = "desc",
    ) -> OffsetPagination[AccessLogDebugEntry]:
        """List debug lines newest-first, with access-log context when linked."""
        all_filters = [*filters, *time_window]
        rows, total = await access_log_debug_service.list_entries(
            *all_filters,
            ip_addresses=validated_ips(ip_address_in),
            country_codes=country_code_in,
            cities=city_in,
            malformed=malformed,
            order_by=order_by,
            sort_order=sort_order,
        )
        limit_offset = next((f for f in all_filters if isinstance(f, LimitOffset)), None)
        return OffsetPagination[AccessLogDebugEntry](
            items=rows,
            total=total,
            limit=limit_offset.limit if limit_offset else len(rows),
            offset=limit_offset.offset if limit_offset else 0,
        )

    @get("/stats", description="Aggregate debug-line stats for the stat cards.")
    async def get_access_log_debug_stats(
        self,
        access_log_debug_service: NamedDependency[AccessLogDebugService],
        from_timestamp: Annotated[datetime | None, QueryParameter(name="fromTimestamp", required=False)] = None,
        to_timestamp: Annotated[datetime | None, QueryParameter(name="toTimestamp", required=False)] = None,
    ) -> AccessLogDebugStats:
        """Totals, malformed count, and top parse error within the range."""
        return await access_log_debug_service.get_stats(
            on_or_after=from_timestamp, on_or_before=to_timestamp,
        )
