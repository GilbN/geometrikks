"""Dependency providers for the security (CrowdSec) domain."""
from __future__ import annotations

from typing import Annotated

from sqlalchemy.ext.asyncio import AsyncSession

from litestar import Request
from litestar.di import NamedDependency
from litestar.params import QueryParameter
from advanced_alchemy.extensions.litestar import filters

from geometrikks.server import runtime
from geometrikks.services.crowdsec import CrowdSecService
from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository


def provide_crowdsec_service(request: Request) -> CrowdSecService | None:
    """Provide the CrowdSecService from app state.

    Returns None when the integration is not enabled (no LAPI URL/bouncer key).
    """
    return runtime.get_crowdsec_service(request.app)


def provide_crowdsec_poller(request: Request) -> CrowdSecStreamPoller | None:
    """Provide the CrowdSec decision-stream poller from app state.

    Returns None when CrowdSec is disabled or the app is DB-degraded.
    """
    return runtime.get_crowdsec_poller(request.app)


async def provide_security_enrichment_repo(
    db_session: NamedDependency[AsyncSession],
) -> SecurityEnrichmentRepository:
    """Provide SecurityEnrichmentRepository for decision enrichment."""
    return SecurityEnrichmentRepository(session=db_session)


def provide_limit_offset_pagination(
    current_page: Annotated[int, QueryParameter(name="currentPage", ge=1, required=False)] = 1,
    page_size: Annotated[int, QueryParameter(name="pageSize", ge=1, required=False)] = 10,
) -> filters.LimitOffset:
    """Add offset/limit pagination.

    Controller-scoped provider for endpoints that paginate in-memory results
    (CrowdSec decisions); ORM-backed lists use the Advanced Alchemy filter
    dependencies from create_service_dependencies() instead.

    Parameters
    ----------
    current_page : int
        Page number (1-indexed).
    page_size : int
        Number of items per page.
    """
    return filters.LimitOffset(page_size, page_size * (current_page - 1))
