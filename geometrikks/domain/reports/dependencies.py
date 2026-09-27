"""Dependency providers for the reports domain."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from litestar.di import NamedDependency

from geometrikks.domain.reports.abuse_report import AbuseReportRepository
from geometrikks.services.rdap import RdapClient, get_rdap_client


async def provide_abuse_report_repo(
    db_session: NamedDependency[AsyncSession],
) -> AbuseReportRepository:
    """Provide AbuseReportRepository for the abuse report endpoint."""
    return AbuseReportRepository(session=db_session)


def provide_rdap_client() -> RdapClient:
    """Provide the shared RDAP client and its caches."""
    return get_rdap_client()
