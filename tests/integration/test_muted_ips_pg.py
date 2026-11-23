"""muted_ips against Postgres: the migration matches the model."""

from __future__ import annotations

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from geometrikks.domain.muted_ips.models import MutedIp

pytestmark = pytest.mark.anyio


def _only_muted_ips(schema_object, name, type_, reflected, compare_to) -> bool:
    if type_ == "table":
        return name == "muted_ips"
    return schema_object.table.name == "muted_ips"


async def test_migrated_table_matches_the_model(pg_engine):
    async with pg_engine.connect() as connection:
        schema_diffs = await connection.run_sync(
            lambda sync_connection: compare_metadata(
                MigrationContext.configure(
                    sync_connection, opts={"compare_type": True, "include_object": _only_muted_ips}
                ),
                MutedIp.metadata,
            )
        )

    assert schema_diffs == []
