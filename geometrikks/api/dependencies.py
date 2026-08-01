"""Shared dependency providers for API layer."""
from __future__ import annotations

from typing import Annotated

from sqlalchemy.ext.asyncio import AsyncSession

from litestar import Request
from litestar.di import NamedDependency, Provide
from litestar.params import QueryParameter
from advanced_alchemy.extensions.litestar import filters

from geometrikks.config.settings import Settings
from geometrikks.services.crowdsec import CrowdSecService
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.domain.analytics.repositories import LiveStatsRepository, SummaryStatsRepository
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository


def create_settings_provider(settings: Settings) -> Provide:
    """Build the app-level ``settings`` dependency around an explicit object.

    ``create_app()`` registers this so request handlers receive the exact
    settings the app was composed with; tests can pass their own ``Settings``
    to ``create_app(settings=...)`` instead of mutating process state.
    """

    def provide_settings() -> Settings:
        return settings

    return Provide(provide_settings, sync_to_thread=False)


def provide_ingestion_service(request: Request) -> LogIngestionService | None:
    """Provide the LogIngestionService from app state.

    Returns None if the service is not available (degraded mode).
    """
    return getattr(request.app.state, "ingestion_service", None)


def provide_crowdsec_service(request: Request) -> CrowdSecService | None:
    """Provide the CrowdSecService from app state.

    Returns None when the integration is not enabled (no LAPI URL/bouncer key).
    """
    return getattr(request.app.state, "crowdsec_service", None)


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


async def provide_summary_stats_repo(
    db_session: NamedDependency[AsyncSession],
) -> SummaryStatsRepository:
    """Provide SummaryStatsRepository for querying summary statistics."""
    return SummaryStatsRepository(session=db_session)

async def provide_live_stats_repo(
    db_session: NamedDependency[AsyncSession],
) -> LiveStatsRepository:
    """Provide LiveStatsRepository for querying raw data tables."""
    return LiveStatsRepository(session=db_session)
