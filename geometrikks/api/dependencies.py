"""Shared dependency providers for API layer."""
from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from litestar import Request
from litestar.params import Parameter
from litestar.plugins.sqlalchemy import filters
from litestar.exceptions import ClientException
from litestar.status_codes import HTTP_409_CONFLICT

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.domain.geo.models import GeoEvent
from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository
from geometrikks.domain.analytics.repositories import LiveStatsRepository, SummaryStatsRepository


def provide_ingestion_service(request: Request) -> LogIngestionService | None:
    """Provide the LogIngestionService from app state.

    Returns None if the service is not available (degraded mode).
    """
    return getattr(request.app.state, "ingestion_service", None)


async def provide_transaction(
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncSession, None]:
    """Provide a database transaction context."""
    try:
        async with db_session.begin():
            yield db_session
    except IntegrityError as exc:
        raise ClientException(
            status_code=HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


async def provide_geo_location_repo(
    db_session: AsyncSession,
) -> GeoLocationRepository:
    """Provide GeoLocationRepository."""
    return GeoLocationRepository(session=db_session)


async def provide_geo_event_repo(
    db_session: AsyncSession,
) -> GeoEventRepository:
    """Provide GeoEventRepository with eager loading of location."""
    return GeoEventRepository(
        statement=select(GeoEvent).options(selectinload(GeoEvent.location)),
        session=db_session,
    )


async def provide_access_log_repo(
    db_session: AsyncSession,
) -> AccessLogRepository:
    """Provide AccessLogRepository."""
    return AccessLogRepository(session=db_session)


async def provide_access_log_debug_repo(
    db_session: AsyncSession,
) -> AccessLogDebugRepository:
    """Provide AccessLogDebugRepository.

    Note: FK to access_logs removed for TimescaleDB compatibility.
    Use access_log_id for application-level lookups if needed.
    """
    return AccessLogDebugRepository(session=db_session)


def provide_limit_offset_pagination(
    current_page: int = Parameter(ge=1, query="currentPage", default=1, required=False),
    page_size: int = Parameter(
        query="pageSize",
        ge=1,
        default=10,
        required=False,
    ),
) -> filters.LimitOffset:
    """Add offset/limit pagination.

    Return type consumed by `Repository.apply_limit_offset_pagination()`.

    Parameters
    ----------
    current_page : int
        Page number (1-indexed).
    page_size : int
        Number of items per page.
    """
    return filters.LimitOffset(page_size, page_size * (current_page - 1))


async def provice_summary_stats_repo(
    db_session: AsyncSession,
) -> SummaryStatsRepository:
    """Provide SummaryStatsRepository for querying summary statistics."""
    return SummaryStatsRepository(session=db_session)

async def provide_live_stats_repo(
    db_session: AsyncSession,
) -> LiveStatsRepository:
    """Provide LiveStatsRepository for querying raw data tables."""
    return LiveStatsRepository(session=db_session)
