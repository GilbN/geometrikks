from __future__ import annotations

from uuid import UUID

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from sqlalchemy import delete

from geometrikks.domain.muted_ips.models import MutedIp


class MutedIpRepository(SQLAlchemyAsyncRepository[MutedIp]):
    model_type = MutedIp

    async def delete_returning(self, entry_id: UUID) -> MutedIp | None:
        """One DELETE ... RETURNING, so of two deletes racing only one gets the row back."""
        return await self.session.scalar(delete(MutedIp).where(MutedIp.id == entry_id).returning(MutedIp))
