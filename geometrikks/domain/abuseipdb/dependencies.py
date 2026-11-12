"""Dependency providers for the AbuseIPDB domain."""
from __future__ import annotations

from litestar.di import NamedDependency
from litestar.params import SkipValidation
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbReportRepository
from geometrikks.services.abuseipdb import AbuseIpdbClient, get_abuseipdb_client


async def provide_abuseipdb_reports(db_session: NamedDependency[AsyncSession]) -> AbuseIpdbReportRepository:
    return AbuseIpdbReportRepository(session=db_session, wrap_exceptions=False)


def provide_abuseipdb_client(settings: NamedDependency[SkipValidation[Settings]]) -> AbuseIpdbClient | None:
    """The shared client, or None without ABUSEIPDB_API_KEY."""
    return get_abuseipdb_client(settings.abuseipdb)
