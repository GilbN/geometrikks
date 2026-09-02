"""HTTP method storage matches the registered-method parser contract."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

pytestmark = pytest.mark.anyio


async def test_http_method_columns_allow_registered_method_lengths(
    pg_engine: AsyncEngine,
) -> None:
    async with pg_engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT table_name, character_maximum_length "
                    "FROM information_schema.columns "
                    "WHERE table_schema = current_schema() "
                    "AND column_name = 'method' "
                    "AND table_name IN ('access_logs', 'access_log_debug')"
                )
            )
        ).all()

    assert {row.table_name: row.character_maximum_length for row in rows} == {
        "access_logs": 32,
        "access_log_debug": 32,
    }
