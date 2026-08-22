"""Agent schema gate against the real migrated database.

The unit suite mocks the engine, so the gate's SQL never actually runs;
this pins the real version-table name (alembic_versions). A query against
alembic's stock singular name shipped once and made every agent poll the
exception path to "timeout" on boot.
"""
from __future__ import annotations

import pytest

from geometrikks.server import schema_wait

pytestmark = pytest.mark.anyio


async def test_wait_for_schema_ready_on_migrated_db(pg_engine):
    result = await schema_wait.wait_for_schema(pg_engine, timeout=10, poll_interval=0.2)
    assert result == "ready"
