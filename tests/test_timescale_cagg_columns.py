"""In-place column upgrades for the summary and URL CAGGs."""
from __future__ import annotations

import inspect
import re
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


class RecordingConn:
    """AsyncConnection double that records every statement."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    async def execute(self, statement: Any, params: Any = None) -> Any:
        self.statements.append(str(statement))
        return _Scalar(None)


def test_latency_filter_renders_the_exclusion_tuple() -> None:
    assert timescale.LATENCY_STATUS_EXCLUSIONS == (0, 101)
    assert timescale.LATENCY_FILTER == "status_code NOT IN (0, 101)"
    assert timescale.latency_filter("al.") == "al.status_code NOT IN (0, 101)"


def test_cagg_column_ddl() -> None:
    column = timescale.CaggColumn("max_latency", "double precision", "MAX(request_time)")
    assert column.ddl == "max_latency double precision GENERATED ALWAYS AS (MAX(request_time)) STORED"


def test_column_table_covers_every_upgraded_view() -> None:
    assert set(timescale.CAGG_GENERATIONS) == {
        "summary_hourly_stats", "summary_daily_stats", "url_hourly_stats", "url_daily_stats",
    }
    assert set(timescale.CAGG_COLUMNS) == set(timescale.CAGG_GENERATIONS)
    for view, generations in timescale.CAGG_GENERATIONS.items():
        for generation in generations:
            # The count column is what the probe reads, so it must be one of
            # the generation's own columns and a COUNT, which is never NULL
            # once a bucket has been refreshed.
            count = next(c for c in generation.columns if c.name == generation.count)
            assert count.expression.startswith("COUNT(")
        flat = [c.name for g in generations for c in g.columns]
        assert [c.name for c in timescale.CAGG_COLUMNS[view]] == flat
    assert [c.name for c in timescale.CAGG_COLUMNS["summary_hourly_stats"]] == [
        "timed_requests", "latency_requests", "avg_latency", "max_latency", "latency_pct_agg",
    ]
    assert [c.name for c in timescale.CAGG_COLUMNS["url_daily_stats"]] == [
        "timed_hits", "latency_hits", "total_latency",
    ]


async def test_create_statements_define_every_upgrade_column() -> None:
    """Fresh installs get the columns from CREATE with the same expression
    the in-place upgrade uses, so both shapes stay identical."""
    conn = RecordingConn()
    await timescale._create_summary_caggs(cast("Any", conn))
    await timescale._create_url_caggs(cast("Any", conn))
    creates = [s for s in conn.statements if "CREATE MATERIALIZED VIEW" in s]
    for view, columns in timescale.CAGG_COLUMNS.items():
        create = next(s for s in creates if f"IF NOT EXISTS {view}\n" in s or f"IF NOT EXISTS {view} " in s)
        for column in columns:
            assert f"{column.expression} AS {column.name}" in create, (view, column.name)


async def test_url_creates_group_by_host_and_url() -> None:
    conn = RecordingConn()
    await timescale._create_url_caggs(cast("Any", conn))
    creates = [s for s in conn.statements if "CREATE MATERIALIZED VIEW" in s]
    assert len(creates) == 2
    for create in creates:
        assert re.search(r"AS bucket,\s+host,\s+url,", create)
        assert "GROUP BY bucket, host, url" in create
        assert "WHERE url IS NOT NULL" in create


def _url_probe_conn(existing: int, with_host: int) -> Any:
    class ProbeConn:
        def __init__(self) -> None:
            self.params: list[Any] = []

        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            self.params.append(params)
            value = with_host if "column_name = 'host'" in sql else existing

            class _One:
                def scalar_one(self) -> int:
                    return value

            return _One()

    return ProbeConn()


async def test_url_probe_fires_when_a_view_lacks_host() -> None:
    conn = _url_probe_conn(existing=2, with_host=1)
    assert await timescale._url_caggs_need_upgrade(conn) is True
    assert conn.params[0] == {"views": timescale.URL_CAGGS}


async def test_url_probe_is_quiet_when_both_views_carry_host() -> None:
    assert await timescale._url_caggs_need_upgrade(_url_probe_conn(existing=2, with_host=2)) is False


async def test_url_probe_is_quiet_on_a_fresh_database() -> None:
    assert await timescale._url_caggs_need_upgrade(_url_probe_conn(existing=0, with_host=0)) is False


class FakeConn:
    """AsyncConnection double that models an aborted transaction.

    Postgres rejects every statement after a failed DDL until the enclosing
    (sub)transaction rolls back, so `aborted` stays set until a savepoint
    exits with an exception.
    """

    def __init__(
        self,
        fail_alter_on: set[str] | None = None,
        existing: dict[str, set[str]] | None = None,
        fail_drop_once: set[str] | None = None,
        fail_drop_always: set[str] | None = None,
    ) -> None:
        self.fail_alter_on = fail_alter_on or set()
        self.existing = existing or {}
        self.fail_drop_once = fail_drop_once or set()
        self.fail_drop_always = fail_drop_always or set()
        self._drop_once_spent: set[str] = set()
        self.statements: list[str] = []
        self.aborted = False
        self.savepoints = 0

    async def execute(self, statement: Any, params: Any = None) -> Any:
        sql = str(statement)
        self.statements.append(sql)
        if self.aborted:
            raise RuntimeError("current transaction is aborted, commands ignored")
        if "information_schema.columns" in sql:
            view = (params or {}).get("view")
            return [SimpleNamespace(column_name=c) for c in self.existing.get(view, set())]
        if "ALTER MATERIALIZED VIEW" in sql and any(v in sql for v in self.fail_alter_on):
            self.aborted = True
            raise RuntimeError("cannot add column to a continuous aggregate")
        if "DROP MATERIALIZED VIEW" in sql:
            always = next((v for v in self.fail_drop_always if v in sql), None)
            once = next(
                (v for v in self.fail_drop_once if v in sql and v not in self._drop_once_spent), None
            )
            if always is not None or once is not None:
                if once is not None:
                    self._drop_once_spent.add(once)
                self.aborted = True
                raise RuntimeError("tuple concurrently deleted")
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


def _alters(conn: FakeConn, view: str) -> list[str]:
    return [s for s in conn.statements if f"ALTER MATERIALIZED VIEW {view} ADD COLUMN" in s]


async def test_add_only_the_missing_columns_of_a_view() -> None:
    conn = FakeConn(existing={"summary_hourly_stats": {"bucket", "timed_requests", "latency_requests"}})

    dropped = await timescale._add_cagg_columns(cast("Any", conn), ["summary_hourly_stats"])

    assert dropped == []
    added = _alters(conn, "summary_hourly_stats")
    assert [s.split("ADD COLUMN ")[1].split(" ")[0] for s in added] == [
        "avg_latency", "max_latency", "latency_pct_agg",
    ]
    assert conn.savepoints == 3, "each ALTER must run inside its own savepoint"
    assert "FILTER (WHERE status_code NOT IN (0, 101))" in added[0]


async def test_failed_alter_falls_back_to_drop_in_a_healthy_transaction() -> None:
    conn = FakeConn(fail_alter_on={"url_hourly_stats"})

    dropped = await timescale._add_cagg_columns(
        cast("Any", conn), ["summary_hourly_stats", "url_hourly_stats"]
    )

    assert dropped == ["url_hourly_stats"]
    assert conn.savepoints == len(_alters(conn, "summary_hourly_stats")) + 1
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


async def test_drop_url_caggs_retries_a_transient_catalog_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(timescale.asyncio, "sleep", AsyncMock())
    conn = FakeConn(fail_drop_once={"url_hourly_stats"})

    await timescale._drop_url_caggs(cast("Any", conn))

    drops = [s for s in conn.statements if "DROP MATERIALIZED VIEW" in s]
    assert sum("url_hourly_stats" in s for s in drops) == 2
    assert sum("url_daily_stats" in s for s in drops) == 1
    assert conn.savepoints == 3


async def test_drop_url_caggs_gives_up_after_the_last_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(timescale.asyncio, "sleep", AsyncMock())
    conn = FakeConn(fail_drop_always={"url_hourly_stats"})

    with pytest.raises(RuntimeError, match="tuple concurrently deleted"):
        await timescale._drop_url_caggs(cast("Any", conn), attempts=2)

    drops = [s for s in conn.statements if "DROP MATERIALIZED VIEW" in s and "url_hourly_stats" in s]
    assert len(drops) == 2


def _all_columns() -> list[SimpleNamespace]:
    return [
        SimpleNamespace(table_name=view, column_name=column.name)
        for view, columns in timescale.CAGG_COLUMNS.items()
        for column in columns
    ]


async def test_probe_scopes_the_null_check_to_the_raw_window() -> None:
    calls: list[tuple[str, Any]] = []

    class ProbeConn:
        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            calls.append((sql, params))
            if "information_schema.columns" in sql:
                return _all_columns()
            return _Scalar(None)

    pending = await timescale._cagg_columns_need_upgrade(
        cast("Any", ProbeConn()), raw_retention_days=180
    )

    assert pending == []
    null_probes = [(sql, params) for sql, params in calls if "IS NULL" in sql]
    assert len(null_probes) == len(timescale.CAGG_COLUMNS)
    for sql, params in null_probes:
        assert "make_interval(days => :days)" in sql
        assert "bucket >=" in sql
        assert params == {"days": 180}
    summary_probe = next(sql for sql, _ in null_probes if "FROM summary_hourly_stats" in sql)
    assert "(timed_requests IS NULL OR latency_requests IS NULL)" in summary_probe
    url_probe = next(sql for sql, _ in null_probes if "FROM url_daily_stats" in sql)
    assert "(timed_hits IS NULL OR latency_hits IS NULL)" in url_probe


async def test_probe_reports_a_view_with_a_null_count_inside_the_window() -> None:
    class ProbeConn:
        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            if "information_schema.columns" in sql:
                return _all_columns()
            return _Scalar(1 if "summary_daily_stats" in sql else None)

    pending = await timescale._cagg_columns_need_upgrade(
        cast("Any", ProbeConn()), raw_retention_days=30
    )

    assert pending == ["summary_daily_stats"]


async def test_probe_reports_a_view_missing_any_column() -> None:
    """A pre-latency database has timed_requests but no latency columns."""

    class ProbeConn:
        async def execute(self, statement: Any, params: Any = None) -> Any:
            sql = str(statement)
            if "information_schema.columns" in sql:
                return [
                    row for row in _all_columns()
                    if not (row.table_name == "url_hourly_stats" and row.column_name.startswith("latency_"))
                ]
            return _Scalar(None)

    pending = await timescale._cagg_columns_need_upgrade(
        cast("Any", ProbeConn()), raw_retention_days=30
    )

    assert pending == ["url_hourly_stats"]


async def _run_setup(
    monkeypatch: pytest.MonkeyPatch,
    *,
    pending_views: list[str],
    refresh_failed: list[str],
    dropped: list[str] | None = None,
    url_upgrade: bool = False,
    order: list[str] | None = None,
) -> tuple[MagicMock, MagicMock]:
    """Run setup_timescaledb with every DDL step stubbed; return (logger, conn).

    ``order`` collects the probe names in call order when given.
    """
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

    async def url_probe(_conn: Any) -> bool:
        if order is not None:
            order.append("url")
        return url_upgrade

    async def column_probe(_conn: Any, *, raw_retention_days: int) -> list[str]:
        if order is not None:
            order.append("columns")
        return pending_views

    monkeypatch.setattr(timescale, "_url_caggs_need_upgrade", url_probe)
    monkeypatch.setattr(timescale, "_cagg_columns_need_upgrade", AsyncMock(side_effect=column_probe))
    monkeypatch.setattr(timescale, "_add_cagg_columns", AsyncMock(return_value=dropped or []))
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
    return logger, conn


def _events(logger_method: Any) -> dict[str, dict]:
    return {call.args[0]: call.kwargs for call in logger_method.call_args_list if call.args}


async def test_setup_logs_the_views_that_failed_and_the_ones_that_refreshed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger, _ = await _run_setup(
        monkeypatch,
        pending_views=["summary_hourly_stats", "url_daily_stats"],
        refresh_failed=["url_daily_stats"],
    )

    warnings = _events(logger.warning)
    assert warnings["cagg_columns_refresh_failed"]["views"] == ["url_daily_stats"]
    infos = _events(logger.info)
    assert infos["cagg_columns_refresh_done"]["views"] == ["summary_hourly_stats"]


async def test_setup_logs_only_done_when_every_view_refreshed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger, _ = await _run_setup(
        monkeypatch, pending_views=["summary_hourly_stats"], refresh_failed=[]
    )

    assert "cagg_columns_refresh_failed" not in _events(logger.warning)
    assert _events(logger.info)["cagg_columns_refresh_done"]["views"] == ["summary_hourly_stats"]


async def test_setup_logs_the_views_the_upgrade_recreated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger, _ = await _run_setup(
        monkeypatch,
        pending_views=["summary_daily_stats"],
        refresh_failed=[],
        dropped=["summary_daily_stats"],
    )

    assert _events(logger.info)["cagg_views_recreated"]["views"] == ["summary_daily_stats"]


async def test_setup_passes_the_raw_retention_window_to_the_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _run_setup(monkeypatch, pending_views=[], refresh_failed=[])

    probe = cast("Any", timescale._cagg_columns_need_upgrade)
    assert probe.await_args is not None
    assert probe.await_args.kwargs["raw_retention_days"] == 180


async def test_setup_rebuilds_the_url_views_before_probing_columns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    logger, conn = await _run_setup(
        monkeypatch, pending_views=[], refresh_failed=[], url_upgrade=True, order=order
    )

    assert order == ["url", "columns"], "the drop must precede the in-place column probe"
    drops = [
        str(call.args[0]) for call in conn.execute.call_args_list
        if "DROP MATERIALIZED VIEW" in str(call.args[0])
    ]
    assert drops == [
        "DROP MATERIALIZED VIEW IF EXISTS url_hourly_stats CASCADE",
        "DROP MATERIALIZED VIEW IF EXISTS url_daily_stats CASCADE",
    ]
    assert _events(logger.warning)["url_caggs_recreated"]["views"] == timescale.URL_CAGGS
    assert "url_caggs_refresh_failed" not in _events(logger.warning)
    assert _events(logger.info)["url_caggs_refresh_done"]["views"] == timescale.URL_CAGGS
    refresh = cast("Any", timescale.refresh_caggs_range)
    url_refreshes = [c for c in refresh.await_args_list if c.kwargs.get("caggs") == timescale.URL_CAGGS]
    assert len(url_refreshes) == 1
    assert url_refreshes[0].kwargs.get("force", False) is False


async def test_setup_logs_the_url_views_whose_rebuild_refresh_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger, _ = await _run_setup(
        monkeypatch, pending_views=[], refresh_failed=["url_daily_stats"], url_upgrade=True
    )

    assert _events(logger.warning)["url_caggs_refresh_failed"]["views"] == ["url_daily_stats"]
    assert _events(logger.info)["url_caggs_refresh_done"]["views"] == ["url_hourly_stats"]


async def test_setup_leaves_the_url_views_alone_when_they_carry_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger, _ = await _run_setup(monkeypatch, pending_views=[], refresh_failed=[])

    assert "url_caggs_recreated" not in _events(logger.warning)
    refresh = cast("Any", timescale.refresh_caggs_range)
    assert all(c.kwargs.get("caggs") != timescale.URL_CAGGS for c in refresh.await_args_list)
