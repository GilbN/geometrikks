"""Upgrade path for the timed-row count columns on the summary and URL CAGGs."""
from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server import timescale

pytestmark = pytest.mark.anyio


class _Scalar:
    """Minimal stand-in for a Result whose only use is .scalar()."""

    def __init__(self, value: Any = None) -> None:
        self._value = value

    def scalar(self) -> Any:
        return self._value


class FakeConn:
    """AsyncConnection double that models an aborted transaction.

    Postgres rejects every statement after a failed DDL until the enclosing
    (sub)transaction rolls back, so `aborted` stays set until a savepoint
    exits with an exception.
    """

    def __init__(self, fail_alter_on: set[str] | None = None) -> None:
        self.fail_alter_on = fail_alter_on or set()
        self.statements: list[str] = []
        self.aborted = False
        self.savepoints = 0

    async def execute(self, statement: Any, params: Any = None) -> Any:
        sql = str(statement)
        self.statements.append(sql)
        if self.aborted:
            raise RuntimeError("current transaction is aborted, commands ignored")
        if "ALTER MATERIALIZED VIEW" in sql and any(v in sql for v in self.fail_alter_on):
            self.aborted = True
            raise RuntimeError("cannot add column to a continuous aggregate")
        return _Scalar(None)

    def begin_nested(self) -> Any:
        conn = self

        class _Savepoint:
            async def __aenter__(self) -> Any:
                conn.savepoints += 1
                return self

            async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
                if exc_type is not None:
                    conn.aborted = False  # ROLLBACK TO SAVEPOINT heals the transaction
                return False

        return _Savepoint()


async def test_failed_alter_falls_back_to_drop_in_a_healthy_transaction() -> None:
    conn = FakeConn(fail_alter_on={"url_hourly_stats"})

    dropped = await timescale._add_timed_columns(
        cast("Any", conn), ["summary_hourly_stats", "url_hourly_stats"]
    )

    assert dropped == ["url_hourly_stats"]
    assert conn.savepoints == 2, "each ALTER must run inside its own savepoint"
    alter_index = next(
        i for i, sql in enumerate(conn.statements)
        if "ALTER MATERIALIZED VIEW url_hourly_stats" in sql
    )
    drop_index = next(
        i for i, sql in enumerate(conn.statements)
        if "DROP MATERIALIZED VIEW IF EXISTS url_hourly_stats" in sql
    )
    assert drop_index > alter_index
    assert not any(
        "DROP MATERIALIZED VIEW IF EXISTS summary_hourly_stats" in sql
        for sql in conn.statements
    ), "a view whose ALTER succeeded must not be dropped"


async def test_probe_scopes_the_null_check_to_the_raw_window() -> None:
    calls: list[tuple[str, Any]] = []

    class ProbeConn:
        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            calls.append((sql, params))
            if "information_schema.columns" in sql:
                return [
                    SimpleNamespace(table_name=view, column_name=column)
                    for view, column in timescale.TIMED_COUNT_COLUMNS.items()
                ]
            return _Scalar(None)

    pending = await timescale._timed_columns_need_upgrade(
        cast("Any", ProbeConn()), raw_retention_days=180
    )

    assert pending == []
    null_probes = [(sql, params) for sql, params in calls if "IS NULL" in sql]
    assert len(null_probes) == len(timescale.TIMED_COUNT_COLUMNS)
    for sql, params in null_probes:
        assert "make_interval(days => :days)" in sql
        assert "bucket >=" in sql
        assert params == {"days": 180}


async def test_probe_reports_a_view_with_a_null_count_inside_the_window() -> None:
    class ProbeConn:
        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            if "information_schema.columns" in sql:
                return [
                    SimpleNamespace(table_name=view, column_name=column)
                    for view, column in timescale.TIMED_COUNT_COLUMNS.items()
                ]
            return _Scalar(1 if "summary_daily_stats" in sql else None)

    pending = await timescale._timed_columns_need_upgrade(
        cast("Any", ProbeConn()), raw_retention_days=30
    )

    assert pending == ["summary_daily_stats"]


async def _run_setup(
    monkeypatch: pytest.MonkeyPatch,
    *,
    timed_views: list[str],
    refresh_failed: list[str],
    dropped: list[str] | None = None,
) -> MagicMock:
    """Run setup_timescaledb with every DDL step stubbed; return its logger."""
    conn = MagicMock()
    conn.execute = AsyncMock(return_value=_Scalar(None))
    begin_ctx = MagicMock()
    begin_ctx.__aenter__ = AsyncMock(return_value=conn)
    begin_ctx.__aexit__ = AsyncMock(return_value=False)
    engine = MagicMock()
    engine.begin = MagicMock(return_value=begin_ctx)

    for name in dir(timescale):
        attr = getattr(timescale, name)
        if name.startswith(("_create_", "_enable_", "_add_", "_upgrade_")) and inspect.iscoroutinefunction(attr):
            monkeypatch.setattr(timescale, name, AsyncMock(return_value=None))
    monkeypatch.setattr(timescale, "_summary_caggs_need_upgrade", AsyncMock(return_value=False))
    monkeypatch.setattr(timescale, "_location_caggs_need_upgrade", AsyncMock(return_value=False))
    monkeypatch.setattr(
        timescale, "detect_hostname_pollution",
        AsyncMock(return_value=timescale.classify_hostnames(["nginx-01"])),
    )
    monkeypatch.setattr(timescale, "_timed_columns_need_upgrade", AsyncMock(return_value=timed_views))
    monkeypatch.setattr(timescale, "_add_timed_columns", AsyncMock(return_value=dropped or []))
    monkeypatch.setattr(timescale, "backfill_cagg_gaps", AsyncMock(return_value=None))
    monkeypatch.setattr(timescale, "refresh_caggs_range", AsyncMock(return_value=refresh_failed))
    logger = MagicMock()
    monkeypatch.setattr(timescale, "logger", logger)

    analytics = SimpleNamespace(
        raw_retention_days=180,
        debug_retention_days=7,
        hourly_retention_days=365,
        compression_after_days=7,
        cagg_refresh_interval_minutes=5,
    )
    await timescale.setup_timescaledb(engine, cast("Any", analytics))
    return logger


def _events(logger_method: Any) -> dict[str, dict]:
    return {call.args[0]: call.kwargs for call in logger_method.call_args_list if call.args}


async def test_setup_logs_the_views_that_failed_and_the_ones_that_refreshed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = await _run_setup(
        monkeypatch,
        timed_views=["summary_hourly_stats", "url_daily_stats"],
        refresh_failed=["url_daily_stats"],
    )

    warnings = _events(logger.warning)
    assert warnings["cagg_timed_refresh_failed"]["views"] == ["url_daily_stats"]
    infos = _events(logger.info)
    assert infos["cagg_timed_refresh_done"]["views"] == ["summary_hourly_stats"]


async def test_setup_logs_only_done_when_every_view_refreshed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = await _run_setup(
        monkeypatch, timed_views=["summary_hourly_stats"], refresh_failed=[]
    )

    assert "cagg_timed_refresh_failed" not in _events(logger.warning)
    assert _events(logger.info)["cagg_timed_refresh_done"]["views"] == ["summary_hourly_stats"]


async def test_setup_logs_the_views_the_upgrade_recreated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = await _run_setup(
        monkeypatch,
        timed_views=["summary_daily_stats"],
        refresh_failed=[],
        dropped=["summary_daily_stats"],
    )

    assert _events(logger.info)["cagg_timed_views_recreated"]["views"] == ["summary_daily_stats"]


async def test_setup_passes_the_raw_retention_window_to_the_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _run_setup(monkeypatch, timed_views=[], refresh_failed=[])

    probe = cast("Any", timescale._timed_columns_need_upgrade)
    assert probe.await_args is not None
    assert probe.await_args.kwargs["raw_retention_days"] == 180
