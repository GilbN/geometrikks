"""Repository for the api_keys table."""
from __future__ import annotations

from typing import TYPE_CHECKING

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from sqlalchemy import delete, update

from geometrikks.domain.auth.models import ApiKey

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID


class ApiKeyTableRepository(SQLAlchemyAsyncRepository[ApiKey]):
    model_type = ApiKey

    async def set_last_used(self, key_id: UUID, *, at: datetime, ip: str | None) -> None:
        """One UPDATE, so a key revoked in the meantime is simply not touched."""
        await self.session.execute(update(ApiKey).where(ApiKey.id == key_id).values(last_used_at=at, last_used_ip=ip))

    async def delete_returning(self, key_id: UUID) -> ApiKey | None:
        """One DELETE ... RETURNING, so of two revokes racing only one gets the row back."""
        return await self.session.scalar(delete(ApiKey).where(ApiKey.id == key_id).returning(ApiKey))
