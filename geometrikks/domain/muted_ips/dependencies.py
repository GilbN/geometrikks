"""Dependency providers for the muted IPs domain."""

from __future__ import annotations

from ipaddress import IPv4Network, IPv6Network, ip_network

from litestar.di import NamedDependency
from litestar.params import SkipValidation
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from geometrikks.domain.muted_ips.models import MutedIp
from geometrikks.domain.muted_ips.networks import with_mapped_twins
from geometrikks.domain.muted_ips.repositories import MutedIpRepository
from geometrikks.lib.parameters import ExcludeMutedIps


async def provide_muted_ip_repository(db_session: NamedDependency[AsyncSession]) -> MutedIpRepository:
    return MutedIpRepository(session=db_session, wrap_exceptions=False)


async def provide_muted_networks(
    db_engine: NamedDependency[SkipValidation[AsyncEngine]],
    exclude_muted_ips: ExcludeMutedIps = False,
) -> list[IPv4Network | IPv6Network] | None:
    """The saved list with IPv4-mapped twins, or None when the request does not ask for it or the list is empty."""
    if not exclude_muted_ips:
        return None
    # Own connection: Litestar resolves sibling dependencies concurrently, and the request session
    # (also used by provide_drop_snapshot) refuses concurrent operations.
    async with db_engine.connect() as connection:
        values = (await connection.execute(select(MutedIp.network))).scalars().all()
    if not values:
        return None
    return with_mapped_twins([ip_network(str(value)) for value in values])
