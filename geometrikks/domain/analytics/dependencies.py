"""Dependency providers for the analytics domain."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from litestar.di import NamedDependency

from geometrikks.domain.analytics.ip_profile import IpProfileRepository
from geometrikks.domain.analytics.repositories import LiveStatsRepository, SummaryStatsRepository


async def provide_ip_profile_repo(
    db_session: NamedDependency[AsyncSession],
) -> IpProfileRepository:
    """Provide IpProfileRepository for the IP inspector endpoint."""
    return IpProfileRepository(session=db_session)


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
