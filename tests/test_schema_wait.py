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


async def test_wait_ready_immediately(monkeypatch, caplog: pytest.LogCaptureFixture) -> None:
    head = schema_wait.bundled_head_revision()
    engine = await _engine_returning([head])
    with caplog.at_level("INFO"):
        assert await schema_wait.wait_for_schema(engine, timeout=1, poll_interval=0.01) == "ready"
    assert any("schema wait: head reached" in r.getMessage() for r in caplog.records)


async def test_wait_behind_then_catches_up(monkeypatch, caplog: pytest.LogCaptureFixture) -> None:
    head = schema_wait.bundled_head_revision()
    older = next(r.revision for r in _walk_skipping_head())  # any non-head known revision
    engine = await _engine_returning([older, older, head])
    with caplog.at_level("INFO"):
        assert await schema_wait.wait_for_schema(engine, timeout=5, poll_interval=0.01) == "ready"
    progress_lines = [r.getMessage() for r in caplog.records if "retrying" in r.getMessage()]
    assert len(progress_lines) == 2
    # structlog's default (unconfigured) test pipeline doesn't apply %-style
    # substitution, so the rendered message keeps the "db at %s" template
    # with the actual values trailing as positional_args -- just check both
    # the progress-line shape and the values are present somewhere in it.
    assert all("schema wait: db at" in line for line in progress_lines)
    assert all(older in line and head in line for line in progress_lines)
    assert any("schema wait: head reached" in r.getMessage() for r in caplog.records)


async def test_wait_unreachable_logs_progress(caplog: pytest.LogCaptureFixture) -> None:
    head = schema_wait.bundled_head_revision()
    engine = await _engine_returning([Exception("no table"), head])
    with caplog.at_level("INFO"):
        assert await schema_wait.wait_for_schema(engine, timeout=5, poll_interval=0.01) == "ready"
    assert any(
        "no alembic_versions yet / DB unreachable" in r.getMessage() and head in r.getMessage()
        for r in caplog.records
    )


async def test_wait_unknown_revision_is_newer(monkeypatch) -> None:
    engine = await _engine_returning(["ffffffffffff"])
    assert await schema_wait.wait_for_schema(engine, timeout=1, poll_interval=0.01) == "newer"


async def test_wait_times_out(monkeypatch) -> None:
    engine = await _engine_returning([Exception("no table")] * 1000)
    assert await schema_wait.wait_for_schema(engine, timeout=0.05, poll_interval=0.01) == "timeout"


async def test_wait_multiple_results_found_warns_and_keeps_polling(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A branched migration history (more than one alembic_versions row)
    must not be silently swallowed by the generic except -- it's not a
    "not ready yet" case, it's a state the agent gate doesn't support."""
    from sqlalchemy.exc import MultipleResultsFound

    engine = await _engine_returning([MultipleResultsFound()] * 1000)
    with caplog.at_level("WARNING"):
        result = await schema_wait.wait_for_schema(engine, timeout=0.05, poll_interval=0.01)
    assert result == "timeout"
    assert any(
        "alembic_versions has multiple rows" in r.getMessage()
        and "branched migration history" in r.getMessage()
        for r in caplog.records
    )
