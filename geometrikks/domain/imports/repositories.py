"""Repository for ImportJob."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.imports.models import ImportJob
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class ImportJobRepository(SQLAlchemyAsyncRepository[ImportJob]):
    model_type = ImportJob

    async def get_by_checksum(self, checksum: str) -> ImportJob | None:
        job = await self.get_one_or_none(checksum=checksum)
        logger.debug("import_job_checksum_lookup", checksum=checksum, found=job is not None)
        return job
