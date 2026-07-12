"""AccessLog API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.pagination import OffsetPagination
from litestar.params import QueryParameter
from advanced_alchemy.extensions.litestar import filters

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.repositories import AccessLogRepository
from geometrikks.domain.logs.dtos import AccessLogDTO

from geometrikks.api.dependencies import provide_access_log_repo


def build_list_filters(
    from_timestamp: datetime | None,
    to_timestamp: datetime | None,
) -> list[filters.FilterTypes]:
    """Newest-first ordering plus an optional inclusive [from, to] window on timestamp."""
    result: list[filters.FilterTypes] = [
        filters.OrderBy(field_name="timestamp", sort_order="desc"),
    ]
    if from_timestamp is not None or to_timestamp is not None:
        result.append(
            filters.OnBeforeAfter(
                field_name="timestamp",
                on_or_after=from_timestamp,
                on_or_before=to_timestamp,
            )
        )
    return result


class AccessLogController(Controller):
    """Access log endpoints

    Handles CRUD operations for access logs.
    """
    path = "/api/v1/access-logs"
    return_dto = AccessLogDTO 
    tags = ["Access Logs"]

    dependencies = {
        "access_log_repo": Provide(provide_access_log_repo),
    }
    
    @get("/")
    async def list_access_logs(
        self,
        access_log_repo: NamedDependency[AccessLogRepository],
        limit_offset: NamedDependency[filters.LimitOffset],
        from_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
        to_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
    ) -> OffsetPagination[AccessLog]:
        """List access logs newest-first, optionally within a time window."""
        list_filters = build_list_filters(from_timestamp, to_timestamp)
        results, total = await access_log_repo.get_many_and_count(*list_filters, limit_offset)
        return OffsetPagination[AccessLog](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset
        )

