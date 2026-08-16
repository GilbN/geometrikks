"""site_homes: migration shape, upsert precedence, override reconcile."""
from __future__ import annotations

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.anyio


async def test_site_homes_table_exists_with_expected_columns(pg_engine):
    async with pg_engine.connect() as conn:
        cols = {r.column_name for r in await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'site_homes'"
        ))}
    assert {"hostname", "latitude", "longitude", "source", "detected_at"} <= cols
