"""Persistence for the instance_heartbeats table.

Raw statements instead of the service layer: the upsert has to lock on the
instance name and return the row as it was before the write, which the
repository API cannot express.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import msgspec
from sqlalchemy import DateTime, String, Uuid, bindparam, delete, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from geometrikks.domain.instances.models import InstanceHeartbeat


@dataclass(frozen=True, slots=True)
class HeartbeatWrite:
    instance_name: str
    boot_id: UUID
    mode: str
    app_version: str
    schema_revision: str
    started_at: datetime
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PreviousHeartbeat:
    boot_id: UUID
    payload: dict[str, Any]


_LOCK_INSTANCE_NAME = text(
    "SELECT pg_advisory_xact_lock(hashtextextended('instance_heartbeats:' || CAST(:instance_name AS text), 0))"
)

_UPSERT_HEARTBEAT = text(
    """
    INSERT INTO instance_heartbeats
        (instance_name, boot_id, mode, app_version, schema_revision, started_at, last_seen, payload)
    VALUES
        (:instance_name, :boot_id, :mode, :app_version, :schema_revision, :started_at, now(), CAST(:payload AS jsonb))
    ON CONFLICT (instance_name) DO UPDATE SET
        boot_id = EXCLUDED.boot_id,
        mode = EXCLUDED.mode,
        app_version = EXCLUDED.app_version,
        schema_revision = EXCLUDED.schema_revision,
        started_at = EXCLUDED.started_at,
        last_seen = now(),
        payload = EXCLUDED.payload
    """
).bindparams(
    bindparam("instance_name", type_=String),
    bindparam("boot_id", type_=Uuid(as_uuid=True)),
    bindparam("mode", type_=String),
    bindparam("app_version", type_=String),
    bindparam("schema_revision", type_=String),
    bindparam("started_at", type_=DateTime(timezone=True)),
    bindparam("payload", type_=String),
)


async def upsert_heartbeat(
    connection: AsyncConnection, heartbeat_write: HeartbeatWrite
) -> PreviousHeartbeat | None:
    """Write this instance's heartbeat and return the boot ID and payload it replaced.

    None means the row is new. last_seen is set by the database, never by the
    caller. The connection must be inside a transaction (engine.begin()): a
    transaction-scoped advisory lock on the instance name serializes writers
    that share a name, so the row read here is the row this write replaces.
    ON CONFLICT alone cannot promise that under Read Committed.

    The payload goes in as a JSON string cast to jsonb. The app engine's
    json_serializer returns bytes, which asyncpg rejects for a JSONB bind.
    """
    await connection.execute(_LOCK_INSTANCE_NAME, {"instance_name": heartbeat_write.instance_name})
    previous_heartbeat = await read_heartbeat(connection, heartbeat_write.instance_name)
    await connection.execute(
        _UPSERT_HEARTBEAT,
        {
            "instance_name": heartbeat_write.instance_name,
            "boot_id": heartbeat_write.boot_id,
            "mode": heartbeat_write.mode,
            "app_version": heartbeat_write.app_version,
            "schema_revision": heartbeat_write.schema_revision,
            "started_at": heartbeat_write.started_at,
            "payload": msgspec.json.encode(heartbeat_write.payload).decode(),
        },
    )
    return previous_heartbeat


async def read_heartbeat(connection: AsyncConnection, instance_name: str) -> PreviousHeartbeat | None:
    result = await connection.execute(
        select(InstanceHeartbeat.boot_id, InstanceHeartbeat.payload).where(
            InstanceHeartbeat.instance_name == instance_name
        )
    )
    heartbeat_row = result.one_or_none()
    if heartbeat_row is None:
        return None
    return PreviousHeartbeat(boot_id=heartbeat_row.boot_id, payload=heartbeat_row.payload)


async def fetch_heartbeats(session: AsyncSession) -> list[InstanceHeartbeat]:
    result = await session.execute(select(InstanceHeartbeat).order_by(InstanceHeartbeat.instance_name))
    return list(result.scalars().all())


async def delete_heartbeat(session: AsyncSession, instance_name: str) -> InstanceHeartbeat | None:
    """Delete one instance's row and return it. The caller commits."""
    result = await session.execute(
        delete(InstanceHeartbeat)
        .where(InstanceHeartbeat.instance_name == instance_name)
        .returning(InstanceHeartbeat)
    )
    return result.scalar_one_or_none()


async def database_now(session: AsyncSession) -> datetime:
    return (await session.execute(text("SELECT now()"))).scalar_one()
