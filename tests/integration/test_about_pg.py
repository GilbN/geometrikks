"""About's database card against a migrated database."""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from geometrikks.domain.system.controllers.system import _database_versions
from geometrikks.server.schema_wait import bundled_head_revision, bundled_revision_doc

pytestmark = pytest.mark.anyio


async def test_database_versions_report_the_migration_the_db_is_on(pg_engine: AsyncEngine):
    versions = await _database_versions(pg_engine)
    head = bundled_head_revision()
    assert versions.migration_revision == head
    assert versions.migration_head == head
    assert versions.migration_name == bundled_revision_doc(head)
