"""Adds and removes muted IPs."""

from __future__ import annotations

from uuid import UUID

import sqlalchemy.exc

from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError
from geometrikks.domain.muted_ips.models import MutedIp
from geometrikks.domain.muted_ips.networks import (
    MUTED_IPS_CAP,
    normalize_network,
    normalize_note,
)
from geometrikks.domain.muted_ips.repositories import MutedIpRepository
from geometrikks.domain.muted_ips.schemas import CreateMutedIpPayload
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

ALREADY_MUTED_DETAIL = "That IP or range is already muted."


async def add_muted_ip(repo: MutedIpRepository, payload: CreateMutedIpPayload) -> MutedIp:
    network = normalize_network(payload.network)
    note = normalize_note(payload.note)
    if await repo.exists(MutedIp.network == network):
        raise DomainConflictError(ALREADY_MUTED_DETAIL, code="muted_ip_exists")
    if await repo.count() >= MUTED_IPS_CAP:
        raise DomainConflictError(
            f"The list is full ({MUTED_IPS_CAP} entries). Remove one first.", code="muted_ip_list_full"
        )
    try:
        muted_ip = await repo.add(MutedIp(network=network, note=note), auto_commit=True, auto_refresh=True)
    except sqlalchemy.exc.IntegrityError as error:
        await repo.session.rollback()
        raise DomainConflictError(ALREADY_MUTED_DETAIL, code="muted_ip_exists") from error
    logger.info("muted_ip_added", network=str(network))
    return muted_ip


async def remove_muted_ip(repo: MutedIpRepository, entry_id: UUID) -> MutedIp:
    muted_ip = await repo.get_one_or_none(id=entry_id)
    if muted_ip is None:
        raise DomainNotFoundError("The muted IP does not exist.")
    network = str(muted_ip.network)
    await repo.delete(entry_id)
    await repo.session.commit()
    logger.info("muted_ip_removed", network=network)
    return muted_ip
