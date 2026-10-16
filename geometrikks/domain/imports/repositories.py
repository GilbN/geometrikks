"""Repository for ImportJob."""
from __future__ import annotations

from datetime import datetime

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from sqlalchemy import ColumnElement, select

from geometrikks.domain.imports.models import ImportJob, LokiImport
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class ImportJobRepository(SQLAlchemyAsyncRepository[ImportJob]):
    model_type = ImportJob

    async def get_by_checksum(self, checksum: str) -> ImportJob | None:
        job = await self.get_one_or_none(checksum=checksum)
        logger.debug("import_job_checksum_lookup", checksum=checksum, found=job is not None)
        return job


def _same_tenant(tenant_id: str | None) -> ColumnElement[bool]:
    # tenant_id = NULL is never true in SQL; an unset tenant must still match itself.
    if tenant_id is None:
        return LokiImport.tenant_id.is_(None)
    return LokiImport.tenant_id == tenant_id


class LokiImportRepository(SQLAlchemyAsyncRepository[LokiImport]):
    model_type = LokiImport

    async def find_resumable(
        self, *, url: str, tenant_id: str | None, query: str, since: datetime, before: datetime
    ) -> LokiImport | None:
        """An unfinished run of exactly this range for this selector, newest first."""
        statement = (
            select(LokiImport)
            .where(
                LokiImport.url == url,
                _same_tenant(tenant_id),
                LokiImport.query == query,
                LokiImport.range_start == since,
                LokiImport.range_end == before,
                LokiImport.cursor < LokiImport.range_end,
            )
            .order_by(LokiImport.id.desc())
            .limit(1)
        )
        return await self.get_one_or_none(statement=statement)

    async def find_overlapping(
        self, *, url: str, tenant_id: str | None, query: str, since: datetime, before: datetime
    ) -> LokiImport | None:
        """A run whose imported part [range_start, cursor) overlaps [since, before)."""
        statement = (
            select(LokiImport)
            .where(
                LokiImport.url == url,
                _same_tenant(tenant_id),
                LokiImport.query == query,
                LokiImport.range_start < before,
                LokiImport.cursor > since,
            )
            .order_by(LokiImport.range_start)
            .limit(1)
        )
        return await self.get_one_or_none(statement=statement)
