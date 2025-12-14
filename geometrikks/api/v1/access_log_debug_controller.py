"""AccessLog API endpoints."""
from __future__ import annotations

from litestar import Controller, get
from litestar.di import Provide
from litestar.pagination import OffsetPagination
from litestar.status_codes import HTTP_201_CREATED, HTTP_204_NO_CONTENT
from litestar.plugins.sqlalchemy import filters

from geometrikks.domain.logs.models import AccessLogDebug
from geometrikks.domain.logs.repositories import AccessLogDebugRepository
from geometrikks.domain.logs.dtos import AccessLogDebugDTO

from geometrikks.api.dependencies import provide_access_log_debug_repo

class AccessLogDebugController(Controller):
    """Access log debug endpoints

    Handles CRUD operations for access log debug data.
    """
    path = "/api/v1/access-log-debug"
    return_dto = AccessLogDebugDTO 
    tags = ["Access Log Debug"]

    dependencies = {
        "access_log_debug_repo": Provide(provide_access_log_debug_repo),
    }
    
    @get("/")
    async def list_access_log_debugs(
        self,
        access_log_debug_repo: AccessLogDebugRepository,
        limit_offset: filters.LimitOffset,
    ) -> OffsetPagination[AccessLogDebug]:
        """List all access log debug entries with pagination."""
        results, total = await access_log_debug_repo.list_and_count(limit_offset)
        return OffsetPagination[AccessLogDebug](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset
        )
