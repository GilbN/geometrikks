"""Shared dependency providers for API layer."""

from collections.abc import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from litestar.params import Parameter
from litestar.plugins.sqlalchemy import (
    filters,
)
from litestar.exceptions import ClientException
from litestar.status_codes import HTTP_409_CONFLICT

from geometrikks.services.logparser.logparser import LogParser
from geometrikks.server.plugins import parser
from geometrikks.domain.geo.models import GeoEvent, GeoLocation
from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
from geometrikks.domain.logs.models import AccessLogDebug
from geometrikks.domain.logs.repositories import AccesLogRepository, AccessLogDebugRepository

def provide_parser() -> LogParser:
    return parser


async def provide_transaction(
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncSession, None]:
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
    """Provide GeoEventRepository."""
    return GeoEventRepository(
        statement=select(GeoEvent).options(selectinload(GeoEvent.location)),
        session=db_session)

async def provide_access_log_repo(
    db_session: AsyncSession
) -> AccesLogRepository:
    """Provide AccessLogRepository."""
    return AccesLogRepository(session=db_session)

async def provide_access_log_debug_repo(
    db_session: AsyncSession
) -> AccessLogDebugRepository:
    """Provide AccessLogDebugRepository."""
    return AccessLogDebugRepository(
        statement=select(AccessLogDebug).options(selectinload(AccessLogDebug.access_log)),
        session=db_session)

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
        LIMIT to apply to select.
    page_size : int
        OFFSET to apply to select.
    """
    return filters.LimitOffset(page_size, page_size * (current_page - 1))
