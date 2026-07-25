"""AccessLog API endpoints."""
from __future__ import annotations

import ipaddress
from datetime import datetime
from typing import Annotated

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.exceptions import ValidationException
from litestar.params import QueryParameter, SkipValidation
from sqlalchemy import or_
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

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.schemas import AccessLogFacets
from geometrikks.domain.logs.services import AccessLogService
from geometrikks.domain.logs.dtos import AccessLogDTO


def provide_access_log_time_window(
    from_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
    to_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
) -> list[FilterTypes]:
    """Optional inclusive [from, to] window on the ``timestamp`` column.

    The built-in ``created_at`` / ``updated_at`` filter config targets those
    audit columns; access logs carry the event time on ``timestamp`` instead.
    """
    if from_timestamp is None and to_timestamp is None:
        return []
    return [
        OnBeforeAfter(
            field_name="timestamp",
            on_or_after=from_timestamp,
            on_or_before=to_timestamp,
        )
    ]


def _validate_ip_addresses(ips: list[str]) -> None:
    """Reject non-IP values before they reach an INET bind param.

    Raises:
        ValidationException: If a value is not a valid IP - ``ip_address`` is
            an INET column, so asyncpg would otherwise fail to encode the bind
            param and surface a 500.
    """
    for raw in ips:
        try:
            ipaddress.ip_address(raw)
        except ValueError as exc:
            raise ValidationException(detail=f"Invalid IP address: {raw!r}") from exc


def provide_access_log_in_filters(
    method_in: Annotated[list[str] | None, QueryParameter(name="methodIn", required=False)] = None,
    ip_address_in: Annotated[list[str] | None, QueryParameter(name="ipAddressIn", required=False)] = None,
    city_in: Annotated[list[str] | None, QueryParameter(name="cityIn", required=False)] = None,
    country_code_in: Annotated[list[str] | None, QueryParameter(name="countryCodeIn", required=False)] = None,
    status_in: Annotated[list[int] | None, QueryParameter(name="statusIn", required=False)] = None,
    ip_address_not_in: Annotated[list[str] | None, QueryParameter(name="ipAddressNotIn", required=False)] = None,
    host_in: Annotated[list[str] | None, QueryParameter(name="hostIn", required=False)] = None,
    host_not_in: Annotated[list[str] | None, QueryParameter(name="hostNotIn", required=False)] = None,
) -> list[FilterTypes]:
    """Include/exclude matches on method / IP / city / country / status / host.

    Provided here rather than via the built-in ``in_fields`` config, whose
    generated providers yield ``None`` when the param is absent and fail the
    aggregating ``filters`` dependency's object validation.

    Host matching is exact on both sides: the filter bar picks from the
    ``/facets`` host list rather than typing free text. ``hostNotIn`` is OR'd
    with ``host IS NULL`` because ``host`` is nullable and SQL evaluates
    ``NULL NOT IN (...)`` as NULL rather than TRUE - a bare NOT IN would
    silently drop every row whose host never parsed. ``ip_address`` is
    NOT NULL, so ``ipAddressNotIn`` needs no such treatment.

    Raises:
        ValidationException: If an ``ipAddressIn``/``ipAddressNotIn`` value is
            not a valid IP.
    """
    result: list[FilterTypes] = []
    if method_in:
        result.append(CollectionFilter(field_name="method", values=method_in))
    if ip_address_in:
        _validate_ip_addresses(ip_address_in)
        result.append(CollectionFilter(field_name="ip_address", values=ip_address_in))
    if city_in:
        result.append(CollectionFilter(field_name="city", values=city_in))
    if country_code_in:
        result.append(CollectionFilter(field_name="country_code", values=country_code_in))
    if status_in:
        result.append(CollectionFilter(field_name="status_code", values=status_in))
    if ip_address_not_in:
        _validate_ip_addresses(ip_address_not_in)
        result.append(NotInCollectionFilter(field_name="ip_address", values=ip_address_not_in))
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
    return result


class AccessLogController(Controller):
    """Access log endpoints

    Handles read operations for access logs with filtering, search, sorting,
    and pagination.
    """
    path = "/api/v1/access-logs"
    return_dto = AccessLogDTO
    tags = ["Access Logs"]

    dependencies = create_service_dependencies(
        AccessLogService,
        key="access_log_service",
        # No config here: constructing it needs Settings(), which must not run
        # at import time. The service provider falls back to the request-scoped
        # ``db_session`` dependency registered by SQLAlchemyInitPlugin.
        filters={
            "pagination_type": "limit_offset",   # -> ?currentPage & ?pageSize
            "pagination_size": 50,
            "search": "url,referrer,user_agent",  # -> ?searchString
            "search_ignore_case": True,
            "sort_field": "timestamp",            # default; overridable via ?orderBy
            "sort_order": "desc",                 # -> ?sortOrder
        },
    ) | {
        "time_window": Provide(provide_access_log_time_window, sync_to_thread=False),
        "in_filters": Provide(provide_access_log_in_filters, sync_to_thread=False),
    }

    @get("/")
    async def list_access_logs(
        self,
        access_log_service: NamedDependency[AccessLogService],
        filters: NamedDependency[SkipValidation[list[FilterTypes]]],
        time_window: NamedDependency[SkipValidation[list[FilterTypes]]],
        in_filters: NamedDependency[SkipValidation[list[FilterTypes]]],
    ) -> OffsetPagination[AccessLog]:
        """List access logs newest-first, with optional search/filter/sort."""
        all_filters = [*filters, *time_window, *in_filters]
        results, total = await access_log_service.get_many_and_count(*all_filters)
        return access_log_service.to_schema(results, total, filters=all_filters)

    @get("/facets", return_dto=None)
    async def get_access_log_facets(
        self,
        access_log_service: NamedDependency[AccessLogService],
    ) -> AccessLogFacets:
        """Distinct country/city/host values present in the data, for filter dropdowns.

        ``return_dto=None`` opts out of the controller-level ``AccessLogDTO``
        (bound to the AccessLog model); Litestar serializes the dataclasses
        directly. Field names are single words, so no camelCase rename needed.
        """
        return await access_log_service.get_facets()
