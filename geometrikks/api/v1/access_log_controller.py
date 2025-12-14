"""AccessLog API endpoints."""
from __future__ import annotations

from litestar import Controller, get
from litestar.di import Provide
from litestar.pagination import OffsetPagination
from litestar.status_codes import HTTP_201_CREATED, HTTP_204_NO_CONTENT
from litestar.plugins.sqlalchemy import filters

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.repositories import AccesLogRepository
from geometrikks.domain.logs.dtos import AccessLogDTO

from geometrikks.api.dependencies import provide_access_log_repo

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
        access_log_repo: AccesLogRepository,
        limit_offset: filters.LimitOffset,
    ) -> OffsetPagination[AccessLog]:
        """List all access logs with pagination."""
        results, total = await access_log_repo.list_and_count(limit_offset)
        return OffsetPagination[AccessLog](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset
        )

