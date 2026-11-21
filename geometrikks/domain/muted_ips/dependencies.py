"""Dependency providers for the muted IPs domain."""

from __future__ import annotations

from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.muted_ips.repositories import MutedIpRepository


async def provide_muted_ip_repository(db_session: NamedDependency[AsyncSession]) -> MutedIpRepository:
    return MutedIpRepository(session=db_session, wrap_exceptions=False)
