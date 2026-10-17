"""Heartbeat rows: one per running instance, upserted every 30 s and read by the head."""
from datetime import datetime
from typing import Any
from uuid import UUID

from advanced_alchemy import base
from advanced_alchemy.types import DateTimeUTC
from sqlalchemy import String, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

INSTANCE_HEARTBEAT_COLUMNS = frozenset(
    {
        "id",
        "instance_name",
        "boot_id",
        "mode",
        "app_version",
        "schema_revision",
        "started_at",
        "last_seen",
        "payload",
    }
)


class InstanceHeartbeat(base.BigIntBase):
    """The latest heartbeat of one instance, keyed by instance_name.

    last_seen is stamped by the database clock so the head compares agent
    freshness against its own clock source, not each agent's. The table only
    gains nullable columns and payload keys are added, never renamed, because
    an older instance can read rows written by a newer one mid-upgrade.
    """

    __tablename__ = "instance_heartbeats"

    instance_name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    boot_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    app_version: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_revision: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True), nullable=False, server_default=func.now()
    )
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    def __repr__(self) -> str:
        return f"<InstanceHeartbeat {self.instance_name} boot={self.boot_id}>"
