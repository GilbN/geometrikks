"""Persistence for the instance_heartbeats table.

Raw statements instead of the service layer: the upsert has to return the
row as it was before the write, which the repository API cannot express.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import DateTime, String, Uuid, bindparam, delete, select, text
from sqlalchemy.dialects.postgresql import JSONB
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


_UPSERT_HEARTBEAT = (
    text(
        """
        WITH previous AS (
            SELECT boot_id, payload FROM instance_heartbeats WHERE instance_name = :instance_name
        )
        INSERT INTO instance_heartbeats
            (instance_name, boot_id, mode, app_version, schema_revision, started_at, last_seen, payload)
        VALUES
            (:instance_name, :boot_id, :mode, :app_version, :schema_revision, :started_at, now(), :payload)
        ON CONFLICT (instance_name) DO UPDATE SET
            boot_id = EXCLUDED.boot_id,
            mode = EXCLUDED.mode,
            app_version = EXCLUDED.app_version,
            schema_revision = EXCLUDED.schema_revision,
            started_at = EXCLUDED.started_at,
            last_seen = now(),
            payload = EXCLUDED.payload
        RETURNING (SELECT boot_id FROM previous) AS previous_boot_id,
                  (SELECT payload FROM previous) AS previous_payload
        """
    )
    .bindparams(
        bindparam("instance_name", type_=String),
        bindparam("boot_id", type_=Uuid(as_uuid=True)),
        bindparam("mode", type_=String),
        bindparam("app_version", type_=String),
        bindparam("schema_revision", type_=String),
        bindparam("started_at", type_=DateTime(timezone=True)),
        bindparam("payload", type_=JSONB),
    )
    .columns(previous_boot_id=Uuid(as_uuid=True), previous_payload=JSONB)
)


async def upsert_heartbeat(
    connection: AsyncConnection, heartbeat_write: HeartbeatWrite
) -> PreviousHeartbeat | None:
    """Write this instance's heartbeat and return the boot ID and payload it replaced.

    One statement, so the CTE reads the snapshot from before the write. None
    means the row is new. last_seen is set by the database, never by the caller.
    """
    result = await connection.execute(
        _UPSERT_HEARTBEAT,
        {
            "instance_name": heartbeat_write.instance_name,
            "boot_id": heartbeat_write.boot_id,
            "mode": heartbeat_write.mode,
            "app_version": heartbeat_write.app_version,
            "schema_revision": heartbeat_write.schema_revision,
            "started_at": heartbeat_write.started_at,
            "payload": heartbeat_write.payload,
        },
    )
    returned_row = result.one()
    if returned_row.previous_boot_id is None:
        return None
    return PreviousHeartbeat(boot_id=returned_row.previous_boot_id, payload=returned_row.previous_payload)


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
