"""HeartbeatWriter against the real instance_heartbeats table."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
import structlog
from litestar import Litestar
from sqlalchemy import text

from geometrikks.config.settings import AppSettings, Settings, get_installed_version
from geometrikks.domain.instances.heartbeat import HeartbeatWriter
from geometrikks.domain.instances.repositories import fetch_heartbeats, read_heartbeat
from geometrikks.domain.instances.schemas import decode_payload
from geometrikks.server.schema_wait import bundled_head_revision

pytestmark = pytest.mark.anyio


def _agent_settings() -> Settings:
    return Settings(_env_file=None, app=AppSettings(_env_file=None, mode="agent"))


def _writer(
    pg_engine: Any, started_at: datetime | None = None, boot_id: UUID | None = None
) -> HeartbeatWriter:
    app = Litestar(route_handlers=[])
    if started_at is not None:
        app.state.started_at = started_at
    return HeartbeatWriter(app, _agent_settings(), pg_engine, boot_id=boot_id)


async def _stored_payload(pg_engine: Any) -> dict[str, Any]:
    async with pg_engine.connect() as connection:
        previous_heartbeat = await read_heartbeat(connection, "agent")
    assert previous_heartbeat is not None
    return previous_heartbeat.payload


async def test_beat_writes_identity_columns(pg_engine, pg_session_maker, clean_instance_heartbeats):
    writer = _writer(pg_engine)

    assert await writer.beat() is True

    async with pg_session_maker() as session:
        (heartbeat_row,) = await fetch_heartbeats(session)
    assert heartbeat_row.instance_name == "agent"
    assert heartbeat_row.boot_id == writer.boot_id
    assert heartbeat_row.mode == "agent"
    assert heartbeat_row.app_version == get_installed_version()
    assert heartbeat_row.schema_revision == bundled_head_revision()
    assert heartbeat_row.payload["instanceNameSource"] == "fallback"


async def test_restart_carries_recent_starts_forward(pg_engine, clean_instance_heartbeats):
    first_start = datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc)
    second_start = first_start + timedelta(minutes=5)
    writer_a = _writer(pg_engine, started_at=first_start)
    writer_b = _writer(pg_engine, started_at=second_start)

    assert await writer_a.beat() is True
    assert await writer_b.beat() is True

    payload = decode_payload(await _stored_payload(pg_engine))
    assert payload is not None
    assert payload.recent_starts == [second_start, first_start]


async def test_retry_after_an_unrecorded_commit_keeps_recent_starts(
    pg_engine, clean_instance_heartbeats
):
    first_start = datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc)
    second_start = first_start + timedelta(minutes=5)
    assert await _writer(pg_engine, started_at=first_start).beat() is True
    committed_writer = _writer(pg_engine, started_at=second_start)
    assert await committed_writer.beat() is True

    # Same boot ID, nothing recorded in memory: the state a write leaves when
    # it commits and then times out before the writer notes it.
    retrying_writer = _writer(pg_engine, started_at=second_start, boot_id=committed_writer.boot_id)
    assert await retrying_writer.beat() is True

    payload = decode_payload(await _stored_payload(pg_engine))
    assert payload is not None
    assert payload.recent_starts == [second_start, first_start]


async def test_first_write_after_a_restart_is_not_a_sighting(pg_engine, clean_instance_heartbeats):
    writer_a = _writer(pg_engine)
    writer_b = _writer(pg_engine)

    with structlog.testing.capture_logs() as captured:
        for _ in range(3):
            assert await writer_a.beat() is True
            assert await writer_b.beat() is True

    assert (await _stored_payload(pg_engine)).get("nameConflictAt") is None
    assert [
        log_entry for log_entry in captured if log_entry["event"] == "instance_name_conflict"
    ] == []


async def test_single_foreign_write_is_not_a_conflict(pg_engine, clean_instance_heartbeats):
    writer_a = _writer(pg_engine)
    writer_b = _writer(pg_engine)

    await writer_b.beat()
    await writer_a.beat()
    await writer_b.beat()

    assert (await _stored_payload(pg_engine)).get("nameConflictAt") is None


async def test_alternating_writers_flag_a_conflict(pg_engine, clean_instance_heartbeats):
    writer_a = _writer(pg_engine)
    writer_b = _writer(pg_engine)

    with structlog.testing.capture_logs() as captured:
        for _ in range(4):
            assert await writer_a.beat() is True
            assert await writer_b.beat() is True

    assert (await _stored_payload(pg_engine)).get("nameConflictAt") is not None
    conflict_boot_ids = sorted(
        log_entry["boot_id"] for log_entry in captured if log_entry["event"] == "instance_name_conflict"
    )
    assert conflict_boot_ids == sorted([str(writer_a.boot_id), str(writer_b.boot_id)])


async def test_writer_survives_missing_table_and_recovers(pg_engine, clean_instance_heartbeats):
    writer = _writer(pg_engine)

    with structlog.testing.capture_logs() as captured:
        async with pg_engine.begin() as connection:
            await connection.execute(
                text("ALTER TABLE instance_heartbeats RENAME TO instance_heartbeats_hidden")
            )
        try:
            assert await writer.beat() is False
        finally:
            async with pg_engine.begin() as connection:
                await connection.execute(
                    text("ALTER TABLE instance_heartbeats_hidden RENAME TO instance_heartbeats")
                )
        assert await writer.beat() is True

    events = [log_entry["event"] for log_entry in captured]
    assert events.count("heartbeat_write_failed") == 1
    assert events.count("heartbeat_write_recovered") == 1
