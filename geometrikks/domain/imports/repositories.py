"""Repository for ImportJob."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.imports.models import ImportJob


class ImportJobRepository(SQLAlchemyAsyncRepository[ImportJob]):
    model_type = ImportJob

    async def get_by_checksum(self, checksum: str) -> ImportJob | None:
        return await self.get_one_or_none(checksum=checksum)
