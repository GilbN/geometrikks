"""instance_heartbeats: upsert returns the pre-write row, last_seen is the database clock."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from geometrikks.domain.instances.repositories import (
    HeartbeatWrite,
    PreviousHeartbeat,
    database_now,
    delete_heartbeat,
    fetch_heartbeats,
    read_heartbeat,
    upsert_heartbeat,
)

pytestmark = pytest.mark.anyio


def _heartbeat_write(
    instance_name: str = "nginx-agent",
    boot_id: UUID | None = None,
    started_at: datetime | None = None,
    payload: dict[str, Any] | None = None,
) -> HeartbeatWrite:
    return HeartbeatWrite(
        instance_name=instance_name,
        boot_id=boot_id or uuid4(),
        mode="agent",
        app_version="0.20.0",
        schema_revision="18be2778bd7c",
        started_at=started_at or datetime.now(timezone.utc),
        payload=payload or {},
    )


async def test_first_upsert_returns_none_and_stores_row(
    pg_engine, pg_session_maker, clean_instance_heartbeats
):
    heartbeat_write = _heartbeat_write(payload={"k": 1})
    async with pg_engine.begin() as connection:
        previous_heartbeat = await upsert_heartbeat(connection, heartbeat_write)
    assert previous_heartbeat is None

    async with pg_session_maker() as session:
        heartbeat_rows = await fetch_heartbeats(session)
        database_clock = await database_now(session)
    assert len(heartbeat_rows) == 1
    heartbeat_row = heartbeat_rows[0]
    assert heartbeat_row.instance_name == "nginx-agent"
    assert heartbeat_row.boot_id == heartbeat_write.boot_id
    assert heartbeat_row.mode == "agent"
    assert heartbeat_row.app_version == "0.20.0"
    assert heartbeat_row.schema_revision == "18be2778bd7c"
    assert heartbeat_row.started_at == heartbeat_write.started_at
    assert heartbeat_row.payload == {"k": 1}
    assert abs(database_clock - heartbeat_row.last_seen) < timedelta(seconds=5)


async def test_upsert_returns_previous_boot_id_and_payload(
    pg_engine, pg_session_maker, clean_instance_heartbeats
):
    boot_a, boot_b = uuid4(), uuid4()
    async with pg_engine.begin() as connection:
        await upsert_heartbeat(connection, _heartbeat_write(boot_id=boot_a, payload={"k": 1}))
    async with pg_engine.begin() as connection:
        previous_heartbeat = await upsert_heartbeat(
            connection, _heartbeat_write(boot_id=boot_b, payload={"k": 2})
        )
    assert previous_heartbeat == PreviousHeartbeat(boot_id=boot_a, payload={"k": 1})

    async with pg_engine.connect() as connection:
        stored_heartbeat = await read_heartbeat(connection, "nginx-agent")
    assert stored_heartbeat == PreviousHeartbeat(boot_id=boot_b, payload={"k": 2})
    async with pg_session_maker() as session:
        assert len(await fetch_heartbeats(session)) == 1


async def test_read_heartbeat_returns_none_for_unknown_name(pg_engine, clean_instance_heartbeats):
    async with pg_engine.connect() as connection:
        assert await read_heartbeat(connection, "missing") is None


async def test_last_seen_comes_from_database_clock(
    pg_engine, pg_session_maker, clean_instance_heartbeats
):
    future_start = datetime.now(timezone.utc) + timedelta(hours=3)
    async with pg_engine.begin() as connection:
        await upsert_heartbeat(connection, _heartbeat_write(started_at=future_start))
    async with pg_session_maker() as session:
        heartbeat_row = (await fetch_heartbeats(session))[0]
        database_clock = await database_now(session)
    assert abs(database_clock - heartbeat_row.last_seen) < timedelta(seconds=5)


async def test_fetch_heartbeats_orders_by_instance_name(
    pg_engine, pg_session_maker, clean_instance_heartbeats
):
    async with pg_engine.begin() as connection:
        for instance_name in ("traefik-agent", "head", "nginx-agent"):
            await upsert_heartbeat(connection, _heartbeat_write(instance_name=instance_name))
    async with pg_session_maker() as session:
        instance_names = [heartbeat_row.instance_name for heartbeat_row in await fetch_heartbeats(session)]
    assert instance_names == ["head", "nginx-agent", "traefik-agent"]


async def test_delete_heartbeat_returns_row_then_none(
    pg_engine, pg_session_maker, clean_instance_heartbeats
):
    async with pg_engine.begin() as connection:
        await upsert_heartbeat(connection, _heartbeat_write())
    async with pg_session_maker() as session:
        deleted_row = await delete_heartbeat(session, "nginx-agent")
        await session.commit()
        assert deleted_row is not None
        assert deleted_row.instance_name == "nginx-agent"
        assert await delete_heartbeat(session, "nginx-agent") is None
    async with pg_engine.connect() as connection:
        remaining = (await connection.execute(text("SELECT count(*) FROM instance_heartbeats"))).scalar_one()
    assert remaining == 0
