"""Agent schema gate: bundled head inspection and the wait loop."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server import schema_wait

pytestmark = pytest.mark.anyio


def test_bundled_head_revision_is_a_hash() -> None:
    head = schema_wait.bundled_head_revision()
    assert isinstance(head, str) and len(head) >= 8
    assert head in schema_wait.known_revisions()


def _walk_skipping_head():
    """All bundled revisions except the head (any is a valid "behind" state)."""
    head = schema_wait.bundled_head_revision()
    script = schema_wait._script_directory()
    return (r for r in script.walk_revisions() if r.revision != head)


async def _engine_returning(values: list):
    """Engine mock whose successive alembic_version reads yield `values`
    (an exception instance in the list is raised instead)."""
    remaining = list(values)

    def _execute(*args, **kwargs):
        if not remaining:
            raise AssertionError("_engine_returning: no more values queued")
        value = remaining.pop(0)
        if isinstance(value, Exception):
            raise value
        result = MagicMock()
        result.scalar_one.return_value = value
        return result

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=_execute)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=conn)
    return engine


async def test_wait_ready_immediately(monkeypatch) -> None:
    head = schema_wait.bundled_head_revision()
    engine = await _engine_returning([head])
    assert await schema_wait.wait_for_schema(engine, timeout=1, poll_interval=0.01) == "ready"


async def test_wait_behind_then_catches_up(monkeypatch) -> None:
    head = schema_wait.bundled_head_revision()
    older = next(r.revision for r in _walk_skipping_head())  # any non-head known revision
    engine = await _engine_returning([older, older, head])
    assert await schema_wait.wait_for_schema(engine, timeout=5, poll_interval=0.01) == "ready"


async def test_wait_unknown_revision_is_newer(monkeypatch) -> None:
    engine = await _engine_returning(["ffffffffffff"])
    assert await schema_wait.wait_for_schema(engine, timeout=1, poll_interval=0.01) == "newer"


async def test_wait_times_out(monkeypatch) -> None:
    engine = await _engine_returning([Exception("no table")] * 1000)
    assert await schema_wait.wait_for_schema(engine, timeout=0.05, poll_interval=0.01) == "timeout"
