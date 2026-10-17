"""CLI plugin registration and command surface."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from click.testing import CliRunner


def test_cli_plugin_registers_command() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "import-logs" in cli.commands


def test_import_logs_rejects_blank_hostname(tmp_path) -> None:
    """Whitespace-only --hostname must fail fast, matching the settings-side
    rejection of blank entries, instead of stamping whitespace into rows."""
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")
    result = CliRunner().invoke(cli, ["import-logs", "--hostname", "  ", str(log)])
    assert result.exit_code != 0
    assert "hostname" in result.output.lower()


def test_import_logs_threads_stripped_hostname_to_run_import(tmp_path, monkeypatch) -> None:
    """--hostname reaches _run_import stripped of incidental surrounding
    whitespace, not the raw entry -- this is what actually gets stamped on
    imported records."""
    import click

    import geometrikks.cli as cli_module
    from geometrikks.cli import ImportLogsCLIPlugin

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_import", run_import)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")
    result = CliRunner().invoke(cli, ["import-logs", "--hostname", " vps-9 ", str(log)])

    assert result.exit_code == 0, result.output
    assert run_import.await_args is not None
    assert run_import.await_args.kwargs["hostname"] == "vps-9"


def test_import_logs_help_runs_without_app() -> None:
    """--help must not construct settings/engine (import-time safety)."""
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["import-logs", "--help"])
    assert result.exit_code == 0
    assert "--force" in result.output


def test_import_logs_help_lists_hostname_option() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["import-logs", "--help"])
    assert result.exit_code == 0
    assert "--hostname" in result.output


def test_import_logs_accepts_import_only_format(tmp_path, monkeypatch) -> None:
    import click

    import geometrikks.cli as cli_module
    from geometrikks.cli import ImportLogsCLIPlugin

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_import", run_import)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    log = tmp_path / "proxy-host-1_access.log"
    log.write_text("", encoding="utf-8")
    result = CliRunner().invoke(cli, ["import-logs", "--format", "npm", str(log)])

    assert result.exit_code == 0, result.output
    assert run_import.await_args is not None
    assert run_import.await_args.kwargs["log_format"] == "npm"


def test_import_logs_before_is_utc_when_no_offset(tmp_path, monkeypatch) -> None:
    from datetime import datetime, timezone

    import click

    import geometrikks.cli as cli_module
    from geometrikks.cli import ImportLogsCLIPlugin

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_import", run_import)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")

    result = CliRunner().invoke(cli, ["import-logs", "--before", "2026-10-01T12:00:00", str(log)])
    assert result.exit_code == 0, result.output
    assert run_import.await_args is not None
    assert run_import.await_args.kwargs["before"] == datetime(2026, 10, 1, 12, tzinfo=timezone.utc)

    result = CliRunner().invoke(cli, ["import-logs", str(log)])
    assert result.exit_code == 0, result.output
    assert run_import.await_args.kwargs["before"] is None


def test_import_logs_before_accepts_fractional_seconds(tmp_path, monkeypatch) -> None:
    from datetime import datetime, timezone

    import geometrikks.cli as cli_module

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_import", run_import)
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")

    result = CliRunner().invoke(
        _loki_cli(), ["import-logs", "--before", "2026-10-01T12:00:00.5", str(log)]
    )

    assert result.exit_code == 0, result.output
    assert run_import.await_args is not None
    assert run_import.await_args.kwargs["before"] == datetime(
        2026, 10, 1, 12, 0, 0, 500000, tzinfo=timezone.utc
    )


def test_import_logs_rejects_bad_before(tmp_path) -> None:
    import click

    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")
    result = CliRunner().invoke(cli, ["import-logs", "--before", "yesterday", str(log)])
    assert result.exit_code != 0
    assert "--before" in result.output


def test_cli_plugin_registers_backfill_hostname() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "backfill-hostname" in cli.commands


def test_backfill_hostname_requires_name() -> None:
    """Invoking without NAME must fail click parsing, not construct an engine."""
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["backfill-hostname"])
    assert result.exit_code != 0
    assert "Missing argument" in result.output


def _make_engine(distinct_rows: list[tuple[str, int]]) -> MagicMock:
    """Engine whose connect()/begin() are async context managers.

    connect() yields a conn whose execute() resolves to a result with
    .all() and .one(); begin() is left for the caller to assert on, since
    the abort path in _run_backfill_hostname must never reach it.
    """
    result = MagicMock()
    result.all.return_value = distinct_rows

    conn = MagicMock()
    conn.execute = AsyncMock(return_value=result)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=conn)
    engine.begin = MagicMock(side_effect=AssertionError("begin() must not run when aborted"))
    engine.dispose = AsyncMock()
    return engine


def _make_updating_engine(
    distinct_rows: list[tuple[str, int]], *, rowcount: int
) -> MagicMock:
    """Engine that also serves the write path: begin() plus MIN/MAX bounds.

    Every UPDATE reports ``rowcount``; the bounds query answers with a fixed
    timestamp pair so the CAGG refresh has a range to work with.
    """
    from datetime import datetime, timezone

    read_result = MagicMock()
    read_result.all.return_value = distinct_rows
    read_result.one.return_value = (
        datetime(2026, 1, 1, tzinfo=timezone.utc),
        datetime(2026, 1, 2, tzinfo=timezone.utc),
    )

    write_result = MagicMock()
    write_result.rowcount = rowcount

    read_conn = MagicMock()
    read_conn.execute = AsyncMock(return_value=read_result)
    read_conn.__aenter__ = AsyncMock(return_value=read_conn)
    read_conn.__aexit__ = AsyncMock(return_value=False)

    write_conn = MagicMock()
    write_conn.execute = AsyncMock(return_value=write_result)
    write_conn.__aenter__ = AsyncMock(return_value=write_conn)
    write_conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=read_conn)
    engine.begin = MagicMock(return_value=write_conn)
    engine.dispose = AsyncMock()
    return engine


def _invoke_backfill(monkeypatch, engine: MagicMock, args: list[str], refresh: AsyncMock):
    """Run backfill-hostname against a mocked engine and CAGG refresher."""
    import click

    import geometrikks.server.plugins as plugins_module
    import geometrikks.server.timescale as timescale_module
    from geometrikks.cli import ImportLogsCLIPlugin

    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(timescale_module, "refresh_caggs_range", refresh)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    return CliRunner().invoke(cli, ["backfill-hostname", *args])


def test_backfill_hostname_plain_refreshes_caggs(monkeypatch) -> None:
    """Without --consolidate the CAGGs must still be refreshed when rows changed.

    Otherwise log_source_daily_stats keeps hostname NULL for history, and
    raw retention eventually makes that uncorrectable.
    """
    engine = _make_updating_engine([("abc123def456", 5)], rowcount=7)
    refresh = AsyncMock()

    result = _invoke_backfill(monkeypatch, engine, ["geometrikks"], refresh)

    assert result.exit_code == 0, result.output
    assert "access_logs NULL hostnames filled: 7" in result.output
    assert "Refreshing hostname CAGGs ..." in result.output
    refreshed = [call.kwargs["caggs"] for call in refresh.await_args_list]
    assert refreshed == [["hostname_daily_stats"], ["log_source_daily_stats"]]


def test_backfill_hostname_no_changes_skips_refresh(monkeypatch) -> None:
    engine = _make_updating_engine([("geometrikks", 5)], rowcount=0)
    refresh = AsyncMock()

    result = _invoke_backfill(monkeypatch, engine, ["geometrikks"], refresh)

    assert result.exit_code == 0, result.output
    assert "access_logs NULL hostnames filled: 0" in result.output
    assert "Refreshing hostname CAGGs" not in result.output
    refresh.assert_not_awaited()


def test_backfill_hostname_nothing_to_do_skips_everything(monkeypatch) -> None:
    """No NULL hostnames (and nothing to consolidate): the command must exit
    before decompressing chunks or opening a write transaction."""
    engine = _make_updating_engine([("geometrikks", 5)], rowcount=0)
    engine.connect.return_value.execute.return_value.scalar.return_value = False
    refresh = AsyncMock()

    result = _invoke_backfill(monkeypatch, engine, ["geometrikks"], refresh)

    assert result.exit_code == 0, result.output
    assert "Nothing to do" in result.output
    engine.begin.assert_not_called()
    refresh.assert_not_awaited()


def test_backfill_hostname_decompresses_before_updates(monkeypatch) -> None:
    """Full-table UPDATEs on compressed chunks trip the TimescaleDB tuple
    decompression limit (seen at 18M rows in prod); chunks must be
    decompressed first, like the url/referrer swap migration does."""
    engine = _make_updating_engine([("abc123def456", 5)], rowcount=3)
    refresh = AsyncMock()

    result = _invoke_backfill(
        monkeypatch, engine, ["geometrikks", "--consolidate", "--yes"], refresh
    )

    assert result.exit_code == 0, result.output
    calls = engine.begin.return_value.execute.await_args_list
    stmts = [str(call.args[0]) for call in calls]
    decompress = [i for i, s in enumerate(stmts) if "decompress_chunk" in s]
    updates = [i for i, s in enumerate(stmts) if s.lstrip().startswith("UPDATE")]
    assert decompress, "no decompress_chunk statement was issued"
    assert updates and max(decompress) < min(updates)
    tables = {
        call.args[1]["t"]
        for i, call in enumerate(calls)
        if i in decompress
    }
    assert tables == {"access_logs", "geo_events"}


def test_backfill_hostname_consolidate_yes_skips_prompt(monkeypatch) -> None:
    """--yes runs the rewrite without a confirmation prompt."""
    engine = _make_updating_engine([("abc123def456", 5)], rowcount=3)
    refresh = AsyncMock()

    result = _invoke_backfill(
        monkeypatch, engine, ["geometrikks", "--consolidate", "--yes"], refresh
    )

    assert result.exit_code == 0, result.output
    assert "Rewrite ALL of these?" not in result.output
    assert "geo_events hostnames rewritten: 3" in result.output
    assert "access_logs hostnames rewritten: 3" in result.output
    assert refresh.await_count == 2


def test_backfill_hostname_consolidate_prompts(monkeypatch) -> None:
    """--consolidate without --yes must prompt; answering 'n' aborts with no updates."""
    import click

    import geometrikks.server.plugins as plugins_module
    from geometrikks.cli import ImportLogsCLIPlugin

    engine = _make_engine([("abc123def456", 5), ("abc123def457", 3)])
    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(
        cli, ["backfill-hostname", "geometrikks", "--consolidate"], input="n\n"
    )

    assert result.exit_code == 0, result.output
    assert "Rewrite ALL of these?" in result.output
    assert "Aborted." in result.output
    engine.begin.assert_not_called()
    engine.dispose.assert_awaited_once()


def test_cli_plugin_registers_backfill_asn() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "backfill-asn" in cli.commands


def _make_asn_engine(
    *, null_rows: int, distinct_ips: list[str], rowcount: int,
    geo_distinct_ips: list[str] | None = None, timescale: bool = False,
) -> MagicMock:
    """Engine for the backfill-asn flow, dispatching on SQL substrings.

    connect() answers the EXISTS probe, the count/bounds scan, and the
    keyset-paginated distinct-IP stream (one page per table, then empty, so
    the pagination loop terminates); begin() serves the temp-table writes
    and reports ``rowcount`` on the join UPDATE.
    """
    from datetime import datetime, timezone

    pages = {
        "access_logs": [[SimpleNamespace(ip_text=ip) for ip in distinct_ips], []],
        "geo_events": [[SimpleNamespace(ip_text=ip) for ip in (geo_distinct_ips or distinct_ips)], []],
    }

    def _table(sql: str) -> str:
        return "geo_events" if "geo_events" in sql else "access_logs"

    def _result_for(sql: str) -> MagicMock:
        result = MagicMock()
        result.rowcount = rowcount
        if "EXISTS" in sql and "pg_extension" in sql:
            result.scalar.return_value = timescale
        elif "EXISTS" in sql:
            result.scalar.return_value = null_rows > 0
        elif "COUNT(DISTINCT" in sql:
            result.one.return_value = (null_rows, len(pages[_table(sql)][0]))
        elif "MIN(timestamp)" in sql:
            result.one.return_value = (
                datetime(2026, 1, 1, tzinfo=timezone.utc),
                datetime(2026, 1, 2, tzinfo=timezone.utc),
            )
        elif "DISTINCT ip_address" in sql:
            stream = pages[_table(sql)]
            result.all.return_value = stream.pop(0) if stream else []
        return result

    async def _execute(stmt, params=None):
        return _result_for(str(stmt))

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=_execute)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=conn)
    engine.begin = MagicMock(return_value=conn)
    engine.dispose = AsyncMock()
    return engine


def _invoke_backfill_asn(
    monkeypatch, engine: MagicMock, args: list[str], refresh: AsyncMock,
    *, asn_db_path: str = "tests/GeoLite2-ASN-Test.mmdb", cli_input: str | None = None,
):
    """Run backfill-asn against a mocked engine, real ASN test db, mocked refresh."""
    import click

    import geometrikks.server.plugins as plugins_module
    import geometrikks.server.timescale as timescale_module
    from geometrikks.cli import ImportLogsCLIPlugin
    from geometrikks.config.settings import get_settings

    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(timescale_module, "refresh_caggs_range", refresh)
    monkeypatch.setenv("GEOIP_ASN_DB_PATH", asn_db_path)
    get_settings.cache_clear()

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    try:
        return CliRunner().invoke(cli, ["backfill-asn", *args], input=cli_input)
    finally:
        get_settings.cache_clear()


def test_backfill_asn_access_logs_stamps_and_refreshes(monkeypatch) -> None:
    """The access-logs target retains the original command's behavior."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "access-logs", "--yes"], refresh
    )

    assert result.exit_code == 0, result.output
    assert "access_logs rows updated: 7" in result.output
    assert "geo_events" not in result.output
    refresh.assert_awaited_once()
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["caggs"] == ["asn_hourly_stats", "asn_daily_stats"]


def test_backfill_asn_requires_table(monkeypatch) -> None:
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(monkeypatch, engine, ["--yes"], refresh)

    assert result.exit_code == 2
    assert "Missing option '--table'" in result.output
    engine.connect.assert_not_called()
    refresh.assert_not_awaited()


def test_backfill_asn_geo_events_does_not_touch_access_logs(monkeypatch) -> None:
    """The Geo Logs backfill must not scan, decompress, or update access_logs."""
    engine = _make_asn_engine(
        null_rows=7,
        distinct_ips=["8.8.8.8"],
        geo_distinct_ips=["1.128.0.0"],
        rowcount=7,
        timescale=True,
    )
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "geo-events", "--yes"], refresh
    )

    assert result.exit_code == 0, result.output
    assert "geo_events rows updated: 7" in result.output
    assert "access_logs" not in result.output
    sql = [str(call.args[0]) for call in engine.connect.return_value.execute.await_args_list]
    assert all("access_logs" not in statement for statement in sql)
    table_params = [
        call.args[1]["table"]
        for call in engine.connect.return_value.execute.await_args_list
        if len(call.args) > 1 and isinstance(call.args[1], dict) and "table" in call.args[1]
    ]
    assert table_params == ["geo_events"]
    refresh.assert_awaited_once()
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["caggs"] == [
        "ip_location_hourly_stats",
        "ip_location_daily_stats",
    ]


def test_backfill_asn_nothing_to_do(monkeypatch) -> None:
    engine = _make_asn_engine(null_rows=0, distinct_ips=[], rowcount=0)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "access-logs", "--yes"], refresh
    )

    assert result.exit_code == 0, result.output
    assert "Nothing to do" in result.output
    refresh.assert_not_awaited()


def test_backfill_asn_aborts_without_confirmation(monkeypatch) -> None:
    """Default (no --yes, input 'n'): no write transaction, no refresh."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    engine.begin = MagicMock(side_effect=AssertionError("begin() must not run when aborted"))
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "access-logs"], refresh, cli_input="n\n"
    )

    assert result.exit_code == 0, result.output
    assert "Aborted" in result.output
    refresh.assert_not_awaited()


def test_backfill_asn_fails_without_asn_database(monkeypatch) -> None:
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "access-logs", "--yes"], refresh,
        asn_db_path="/nonexistent/GeoLite2-ASN.mmdb",
    )

    assert result.exit_code != 0
    assert "No GeoLite2 ASN database" in result.output


def test_backfill_asn_exits_nonzero_when_cagg_refresh_fails(monkeypatch) -> None:
    """Rows are stamped but the aggregates stayed stale: the run must not
    report success, or long-range analytics silently miss the backfill."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=["ip_location_daily_stats"])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--table", "geo-events", "--yes"], refresh
    )

    assert result.exit_code != 0
    assert "rows updated: 7" in result.output
    assert "ip_location_daily_stats" in result.output


def _make_timings_engine(count: int, *, rowcount: int) -> MagicMock:
    """Engine for backfill-timings: preview via connect(), UPDATE via begin().

    The preview returns (count, min_ts, max_ts); the EXISTS probe for
    TimescaleDB returns True; every write reports ``rowcount``.
    """
    from datetime import datetime, timezone

    preview = MagicMock()
    preview.one.return_value = (
        count,
        datetime(2026, 1, 1, tzinfo=timezone.utc) if count else None,
        datetime(2026, 1, 2, tzinfo=timezone.utc) if count else None,
    )
    preview.scalar.return_value = True

    write_result = MagicMock()
    write_result.rowcount = rowcount

    read_conn = MagicMock()
    read_conn.execute = AsyncMock(return_value=preview)
    read_conn.__aenter__ = AsyncMock(return_value=read_conn)
    read_conn.__aexit__ = AsyncMock(return_value=False)

    write_conn = MagicMock()
    write_conn.execute = AsyncMock(return_value=write_result)
    write_conn.__aenter__ = AsyncMock(return_value=write_conn)
    write_conn.__aexit__ = AsyncMock(return_value=False)

    engine = MagicMock()
    engine.connect = MagicMock(return_value=read_conn)
    engine.begin = MagicMock(return_value=write_conn)
    engine.dispose = AsyncMock()
    return engine


def _invoke_backfill_timings(monkeypatch, engine: MagicMock, args: list[str], refresh: AsyncMock, cli_input: str | None = None):
    import click

    import geometrikks.server.plugins as plugins_module
    import geometrikks.server.timescale as timescale_module
    from geometrikks.cli import ImportLogsCLIPlugin

    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(timescale_module, "refresh_caggs_range", refresh)

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    return CliRunner().invoke(cli, ["backfill-timings", *args], input=cli_input)


def test_cli_plugin_registers_backfill_timings() -> None:
    import click

    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "backfill-timings" in cli.commands


def test_backfill_timings_nothing_to_do_skips_everything(monkeypatch) -> None:
    engine = _make_timings_engine(0, rowcount=0)
    refresh = AsyncMock(return_value=[])
    result = _invoke_backfill_timings(monkeypatch, engine, ["--yes"], refresh)
    assert result.exit_code == 0, result.output
    assert "Nothing to do" in result.output
    engine.begin.assert_not_called()
    refresh.assert_not_awaited()


def test_backfill_timings_previews_then_updates_and_refreshes(monkeypatch) -> None:
    engine = _make_timings_engine(1200, rowcount=1200)
    refresh = AsyncMock(return_value=[])
    result = _invoke_backfill_timings(monkeypatch, engine, ["--yes"], refresh)
    assert result.exit_code == 0, result.output
    assert "1,200" in result.output
    write_sql = [str(c.args[0]) for c in engine.begin.return_value.execute.await_args_list]
    assert any("decompress_chunk" in s for s in write_sql)
    update = next(s for s in write_sql if "UPDATE access_logs SET request_time = NULL" in s)
    assert "log_format = 'nginx'" in update and "host IS NULL" in update and "request_time = 0" in update
    refresh.assert_awaited()
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["force"] is True
    assert set(refresh.await_args.kwargs["caggs"]) == {
        "summary_hourly_stats", "summary_daily_stats", "url_hourly_stats", "url_daily_stats"
    }


def test_backfill_timings_narrows_by_hostname_and_before(monkeypatch) -> None:
    from datetime import datetime, timezone

    engine = _make_timings_engine(5, rowcount=5)
    refresh = AsyncMock(return_value=[])
    result = _invoke_backfill_timings(
        monkeypatch, engine, ["--yes", "--hostname", "nginx-01", "--before", "2026-08-20"], refresh
    )
    assert result.exit_code == 0, result.output
    preview_call = engine.connect.return_value.execute.await_args_list[0]
    assert "hostname = :hostname" in str(preview_call.args[0])
    assert "timestamp < :before" in str(preview_call.args[0])
    assert preview_call.args[1]["hostname"] == "nginx-01"
    assert preview_call.args[1]["before"] == datetime(2026, 8, 20, tzinfo=timezone.utc)


def test_backfill_timings_aborts_without_confirmation(monkeypatch) -> None:
    engine = _make_timings_engine(5, rowcount=5)
    refresh = AsyncMock(return_value=[])
    result = _invoke_backfill_timings(monkeypatch, engine, [], refresh, cli_input="n\n")
    assert result.exit_code == 0, result.output
    assert "Aborted" in result.output
    engine.begin.assert_not_called()


def test_backfill_timings_rejects_bad_before_date(monkeypatch) -> None:
    engine = _make_timings_engine(5, rowcount=5)
    result = _invoke_backfill_timings(monkeypatch, engine, ["--yes", "--before", "yesterday"], AsyncMock())
    assert result.exit_code != 0
    assert "before" in result.output.lower()


def test_backfill_timings_logs_audit_before_raising_on_refresh_failure(monkeypatch) -> None:
    import geometrikks.server.logging as logging_module

    engine = _make_timings_engine(7, rowcount=7)
    refresh = AsyncMock(return_value=["url_daily_stats"])
    logger = MagicMock()
    monkeypatch.setattr(logging_module, "get_logger", lambda name: logger)
    result = _invoke_backfill_timings(monkeypatch, engine, ["--yes"], refresh)
    assert result.exit_code != 0
    assert "url_daily_stats" in result.output
    logger.info.assert_called_once()
    assert logger.info.call_args.args[0] == "backfill_timings_completed"
    assert logger.info.call_args.kwargs["cleared"] == 7
    assert logger.info.call_args.kwargs["cagg_refresh_failed"] == ["url_daily_stats"]


def test_geo_hostname_backfill_cli_registration_and_help() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli(): ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["backfill-geo-hostnames", "--help"])
    assert result.exit_code == 0
    assert "--yes" in result.output
    assert "--batch-days" not in result.output


def test_geo_hostname_backfill_options(monkeypatch) -> None:
    import geometrikks.cli as module

    run = AsyncMock()
    monkeypatch.setattr(module, "_run_backfill_geo_hostnames", run)
    result = CliRunner().invoke(module.backfill_geo_hostnames_command, ["--yes"])
    assert result.exit_code == 0, result.output
    run.assert_awaited_once_with(yes=True)


def test_import_logs_reports_an_earlier_cutoff_as_a_failed_file(tmp_path, monkeypatch) -> None:
    import click

    import geometrikks.config.settings as settings_module
    import geometrikks.server.plugins as plugins_module
    import geometrikks.services.importer as importer_module
    import geometrikks.services.ingestion.service as ingestion_module
    from geometrikks.cli import ImportLogsCLIPlugin

    log = tmp_path / "proxy-host-1_access.log.2.gz"
    log.write_text("", encoding="utf-8")

    settings = MagicMock()
    settings.geoip.asn_enabled = False
    settings.ingest_server_names.return_value = ["vps-1"]
    monkeypatch.setattr(settings_module, "get_settings", lambda: settings)
    engine = MagicMock()
    engine.dispose = AsyncMock()
    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(ingestion_module, "create_reader", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(ingestion_module, "LogIngestionService", MagicMock())
    monkeypatch.setattr(importer_module, "import_file", AsyncMock(
        side_effect=importer_module.ImportCutoffConflictError(f"{log}: already imported up to X")
    ))

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["import-logs", "--before", "2026-10-01", str(log)])

    assert result.exit_code != 0
    assert "already imported up to X" in result.output
    assert "1 file(s) not imported" in result.output


def test_import_logs_exits_nonzero_when_cagg_refresh_fails(tmp_path, monkeypatch) -> None:
    from datetime import datetime, timezone
    from pathlib import Path

    import click

    import geometrikks.config.settings as settings_module
    import geometrikks.server.plugins as plugins_module
    import geometrikks.server.timescale as timescale_module
    import geometrikks.services.importer as importer_module
    import geometrikks.services.ingestion.service as ingestion_module
    from geometrikks.cli import ImportLogsCLIPlugin

    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")

    settings = MagicMock()
    settings.geoip.asn_enabled = False
    settings.ingest_server_names.return_value = ["vps-1"]
    monkeypatch.setattr(settings_module, "get_settings", lambda: settings)
    engine = MagicMock()
    engine.dispose = AsyncMock()
    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(ingestion_module, "create_reader", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(ingestion_module, "LogIngestionService", MagicMock())
    monkeypatch.setattr(importer_module, "import_file", AsyncMock(return_value=SimpleNamespace(
        file_path=Path(log), skipped=False, lines_total=1, lines_skipped=0,
        records_written=1, lines_after_cutoff=0, lines_already_imported=0,
        time_start=datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
        time_end=datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
        duration_seconds=1.0,
    )))
    monkeypatch.setattr(
        timescale_module, "refresh_caggs_range", AsyncMock(return_value=["summary_daily_stats"])
    )

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["import-logs", str(log)])

    assert result.exit_code != 0
    assert "summary_daily_stats" in result.output
    assert "CAGGs refreshed." not in result.output


def _loki_cli():
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    return cli


def test_cli_plugin_registers_import_loki() -> None:
    assert "import-loki" in _loki_cli().commands


def test_import_loki_help_runs_without_app() -> None:
    result = CliRunner().invoke(_loki_cli(), ["import-loki", "--help"])
    assert result.exit_code == 0, result.output
    for option in ("--since", "--before", "--query", "--force", "--batch-size"):
        assert option in result.output


def test_import_loki_since_is_required() -> None:
    result = CliRunner().invoke(_loki_cli(), ["import-loki"])
    assert result.exit_code != 0
    assert "--since" in result.output


def test_import_loki_naive_datetimes_are_utc(monkeypatch) -> None:
    from datetime import datetime, timezone

    import geometrikks.cli as cli_module

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_loki_import", run_import)

    result = CliRunner().invoke(
        _loki_cli(), ["import-loki", "--since", "2026-09-01", "--before", "2026-10-01T12:00:00"]
    )
    assert result.exit_code == 0, result.output
    assert run_import.await_args is not None
    assert run_import.await_args.kwargs["since"] == datetime(2026, 9, 1, tzinfo=timezone.utc)
    assert run_import.await_args.kwargs["before"] == datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    assert run_import.await_args.kwargs["query_index"] is None
    assert run_import.await_args.kwargs["force"] is False


def test_import_loki_accepts_fractional_seconds(monkeypatch) -> None:
    from datetime import datetime, timezone

    import geometrikks.cli as cli_module

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_loki_import", run_import)
    expected = datetime(2026, 9, 20, 12, 34, 56, 123456, tzinfo=timezone.utc)

    for before in ("2026-09-20T12:34:56.123456+00:00", "2026-09-20T12:34:56.123456"):
        result = CliRunner().invoke(
            _loki_cli(), ["import-loki", "--since", "2026-09-01", "--before", before]
        )
        assert result.exit_code == 0, result.output
        assert run_import.await_args is not None
        assert run_import.await_args.kwargs["before"] == expected


def test_import_loki_rejects_since_at_or_after_before(monkeypatch) -> None:
    import geometrikks.cli as cli_module

    run_import = AsyncMock()
    monkeypatch.setattr(cli_module, "_run_loki_import", run_import)

    result = CliRunner().invoke(
        _loki_cli(), ["import-loki", "--since", "2026-10-01", "--before", "2026-10-01"]
    )
    assert result.exit_code != 0
    assert "earlier than --before" in result.output
    run_import.assert_not_awaited()


def test_import_loki_rejects_query_zero() -> None:
    result = CliRunner().invoke(_loki_cli(), ["import-loki", "--since", "2026-09-01", "--query", "0"])
    assert result.exit_code != 0
    assert "--query" in result.output


def _loki_settings(**loki_fields):
    from geometrikks.config.settings import LogParserSettings, LokiSettings, Settings

    return Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, server_name=["head"]),
        loki=LokiSettings(_env_file=None, **loki_fields),
    )


def test_select_loki_queries_resolves_format_and_hostname_per_query() -> None:
    from geometrikks.cli import select_loki_queries

    settings = _loki_settings(
        url="http://loki:3100",
        queries=['{job="nginx"}', '{job="traefik"}'],
        formats=["auto", "traefik-json"],
        server_names=["edge-01", "edge-02"],
    )
    assert select_loki_queries(settings, None) == [
        (1, '{job="nginx"}', "auto", "edge-01"),
        (2, '{job="traefik"}', "traefik-json", "edge-02"),
    ]
    assert select_loki_queries(settings, 2) == [(2, '{job="traefik"}', "traefik-json", "edge-02")]


def test_select_loki_queries_defaults_hostname_to_the_first_logparser_one() -> None:
    from geometrikks.cli import select_loki_queries

    settings = _loki_settings(url="http://loki:3100", queries=['{job="nginx"}'])
    assert select_loki_queries(settings, None) == [(1, '{job="nginx"}', "auto", "head")]


def test_select_loki_queries_requires_a_loki_source() -> None:
    import click

    from geometrikks.cli import select_loki_queries

    with pytest.raises(click.ClickException, match="LOKI_URL"):
        select_loki_queries(_loki_settings(), None)


def test_select_loki_queries_rejects_an_index_past_the_end() -> None:
    import click

    from geometrikks.cli import select_loki_queries

    settings = _loki_settings(url="http://loki:3100", queries=['{job="nginx"}'])
    with pytest.raises(click.ClickException, match="1 selector"):
        select_loki_queries(settings, 2)


def test_select_loki_queries_rejects_an_index_below_one() -> None:
    import click

    from geometrikks.cli import select_loki_queries

    settings = _loki_settings(url="http://loki:3100", queries=['{job="nginx"}'])
    with pytest.raises(click.ClickException, match="--query 0"):
        select_loki_queries(settings, 0)


def test_resolve_loki_before_default_rejects_since_past_it() -> None:
    """The default --before is where covered data starts; a --since at or after
    it is refused per selector by resolve_loki_before, not sent to Loki."""
    from datetime import datetime, timezone

    import click

    from geometrikks.cli import resolve_loki_before

    oldest = datetime(2026, 9, 1, tzinfo=timezone.utc)
    with pytest.raises(click.ClickException, match="already begin"):
        resolve_loki_before(
            since=oldest, before=None, oldest_row=oldest,
            earliest_import=None, unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
        )
    with pytest.raises(click.ClickException, match="already begin"):
        resolve_loki_before(
            since=oldest, before=None, oldest_row=None,
            earliest_import=oldest, unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
        )
    with pytest.raises(click.ClickException, match="no access-log rows or earlier imports"):
        resolve_loki_before(
            since=oldest, before=None, oldest_row=None,
            earliest_import=None, unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
        )
    assert resolve_loki_before(
        since=oldest - timedelta(days=1), before=None, oldest_row=oldest,
        earliest_import=None, unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
    ) == oldest
    explicit = oldest + timedelta(days=1)
    assert resolve_loki_before(
        since=oldest, before=explicit, oldest_row=None,
        earliest_import=None, unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
    ) == explicit


def test_resolve_loki_before_prefers_an_unfinished_run() -> None:
    from datetime import datetime, timezone

    from geometrikks.cli import resolve_loki_before

    unfinished_end = datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert resolve_loki_before(
        since=datetime(2026, 9, 1, tzinfo=timezone.utc),
        before=None,
        oldest_row=datetime(2026, 9, 15, tzinfo=timezone.utc),
        earliest_import=datetime(2026, 9, 1, tzinfo=timezone.utc),
        unfinished_end=unfinished_end,
        imports_wrote_from=None,
        hostname="edge-01",
    ) == unfinished_end


def test_resolve_loki_before_uses_the_earliest_covered_start() -> None:
    from datetime import datetime, timezone

    from geometrikks.cli import resolve_loki_before

    earlier = datetime(2026, 9, 10, tzinfo=timezone.utc)
    later = datetime(2026, 9, 20, tzinfo=timezone.utc)
    since = datetime(2026, 9, 1, tzinfo=timezone.utc)
    assert resolve_loki_before(
        since=since, before=None, oldest_row=later, earliest_import=earlier,
        unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
    ) == earlier
    assert resolve_loki_before(
        since=since, before=None, oldest_row=earlier, earliest_import=later,
        unfinished_end=None, imports_wrote_from=None, hostname="edge-01",
    ) == earlier


def test_resolve_loki_before_uses_the_import_start_when_the_oldest_row_is_its_own_line() -> None:
    from datetime import datetime, timezone

    from geometrikks.cli import resolve_loki_before

    import_start = datetime(2026, 9, 10, tzinfo=timezone.utc)
    since = datetime(2026, 9, 1, tzinfo=timezone.utc)
    assert resolve_loki_before(
        since=since,
        before=None,
        oldest_row=import_start - timedelta(seconds=2),
        earliest_import=import_start,
        unfinished_end=None,
        imports_wrote_from=import_start - timedelta(seconds=2),
        hostname="edge-01",
    ) == import_start


def test_resolve_loki_before_uses_older_live_rows_when_they_predate_every_import() -> None:
    from datetime import datetime, timezone

    from geometrikks.cli import resolve_loki_before

    import_start = datetime(2026, 9, 10, tzinfo=timezone.utc)
    since = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert resolve_loki_before(
        since=since,
        before=None,
        oldest_row=import_start - timedelta(days=30),
        earliest_import=import_start,
        unfinished_end=None,
        imports_wrote_from=import_start - timedelta(seconds=2),
        hostname="edge-01",
    ) == import_start - timedelta(days=30)


def _patch_loki_run(
    monkeypatch, *, import_loki_range, covered_from, claim_loki_range=None, written_span=None
):
    import geometrikks.cli as cli_module
    import geometrikks.config.settings as settings_module
    import geometrikks.server.plugins as plugins_module
    import geometrikks.server.timescale as timescale_module
    import geometrikks.services.ingestion.service as ingestion_module
    import geometrikks.services.loki_importer as loki_importer_module

    settings = _loki_settings(url="http://loki:3100", queries=['{job="nginx"}', '{job="traefik"}'])
    monkeypatch.setattr(settings_module, "get_settings", lambda: settings)
    engine = MagicMock()
    engine.dispose = AsyncMock()
    config = MagicMock()
    config.get_engine.return_value = engine
    monkeypatch.setattr(plugins_module, "get_sqlalchemy_config", lambda: config)
    monkeypatch.setattr(ingestion_module, "create_reader", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(cli_module, "_covered_from", covered_from)
    monkeypatch.setattr(
        cli_module, "_written_span", written_span or AsyncMock(return_value=(None, None))
    )
    monkeypatch.setattr(loki_importer_module, "import_loki_range", import_loki_range)
    monkeypatch.setattr(
        loki_importer_module, "claim_loki_range", claim_loki_range or AsyncMock()
    )
    refresh = AsyncMock(return_value=[])
    monkeypatch.setattr(timescale_module, "refresh_caggs_range", refresh)
    return engine, refresh


def test_import_loki_continues_after_a_failed_selector_and_exits_nonzero(monkeypatch) -> None:
    from datetime import datetime, timezone

    from geometrikks.services.loki_importer import LokiImportOverlapError, LokiImportResult

    moment = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
    import_loki_range = AsyncMock(
        side_effect=[
            LokiImportOverlapError("taken"),
            LokiImportResult(
                lines_total=1,
                lines_skipped=0,
                records_written=1,
                time_start=moment,
                time_end=moment,
                duration_seconds=0.1,
                resumed_from=None,
            ),
        ]
    )
    engine, refresh = _patch_loki_run(
        monkeypatch, import_loki_range=import_loki_range, covered_from=AsyncMock()
    )

    result = CliRunner().invoke(
        _loki_cli(), ["import-loki", "--since", "2026-09-01", "--before", "2026-10-01"]
    )

    assert result.exit_code != 0
    assert "1 selector(s) not imported" in result.output
    assert import_loki_range.await_count == 2
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["start"] == moment
    engine.dispose.assert_awaited()


def test_import_loki_resolves_every_default_before_importing(monkeypatch) -> None:
    from datetime import datetime, timezone

    from geometrikks.services.loki_importer import LokiImportResult

    oldest = datetime(2026, 9, 20, tzinfo=timezone.utc)
    calls: list[str] = []

    async def covered_from(*args, **kwargs):
        calls.append("covered")
        return oldest, None, None, None

    async def import_loki_range(*args, **kwargs):
        calls.append("import")
        return LokiImportResult(
            lines_total=0,
            lines_skipped=0,
            records_written=0,
            time_start=None,
            time_end=None,
            duration_seconds=0.1,
            resumed_from=None,
        )

    async def claim_loki_range(*args, **kwargs):
        calls.append("claim")

    range_mock = AsyncMock(side_effect=import_loki_range)
    _patch_loki_run(
        monkeypatch,
        import_loki_range=range_mock,
        covered_from=covered_from,
        claim_loki_range=AsyncMock(side_effect=claim_loki_range),
    )

    result = CliRunner().invoke(_loki_cli(), ["import-loki", "--since", "2026-09-01"])

    assert result.exit_code == 0, result.output
    assert calls == ["covered", "covered", "claim", "claim", "import", "import"]
    assert [call.kwargs["before"] for call in range_mock.await_args_list] == [oldest, oldest]


def test_import_loki_refreshes_rows_a_failed_selector_wrote(monkeypatch) -> None:
    from datetime import datetime, timezone

    from geometrikks.services.logsources.loki import LokiRejected

    first_written = datetime(2026, 9, 1, 0, 30, tzinfo=timezone.utc)
    last_written = datetime(2026, 9, 20, 23, 45, tzinfo=timezone.utc)
    import_loki_range = AsyncMock(side_effect=LokiRejected("HTTP 400"))
    written_span = AsyncMock(return_value=(first_written, last_written))
    _, refresh = _patch_loki_run(
        monkeypatch,
        import_loki_range=import_loki_range,
        covered_from=AsyncMock(),
        written_span=written_span,
    )

    result = CliRunner().invoke(
        _loki_cli(),
        ["import-loki", "--since", "2026-09-01", "--before", "2026-10-01", "--query", "1"],
    )

    assert result.exit_code != 0
    assert written_span.await_args is not None
    assert written_span.await_args.kwargs["query"] == '{job="nginx"}'
    assert written_span.await_args.kwargs["before"] == datetime(2026, 10, 1, tzinfo=timezone.utc)
    refresh.assert_awaited_once()
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["start"] == first_written
    assert refresh.await_args.kwargs["end"] == last_written + timedelta(microseconds=1)


def test_import_loki_continues_after_an_unexpected_error(monkeypatch) -> None:
    from datetime import datetime, timezone

    from geometrikks.services.loki_importer import LokiImportResult

    first_line = datetime(2026, 9, 2, 8, tzinfo=timezone.utc)
    last_line = datetime(2026, 9, 3, 17, tzinfo=timezone.utc)
    import_loki_range = AsyncMock(
        side_effect=[
            RuntimeError("db gone"),
            LokiImportResult(
                lines_total=2,
                lines_skipped=0,
                records_written=2,
                time_start=first_line,
                time_end=last_line,
                duration_seconds=0.1,
                resumed_from=None,
            ),
        ]
    )
    engine, refresh = _patch_loki_run(
        monkeypatch, import_loki_range=import_loki_range, covered_from=AsyncMock()
    )

    result = CliRunner().invoke(
        _loki_cli(), ["import-loki", "--since", "2026-09-01", "--before", "2026-10-01"]
    )

    assert result.exit_code != 0
    assert "db gone" in result.output
    assert "1 selector(s) not imported" in result.output
    assert import_loki_range.await_count == 2
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["start"] == first_line
    assert refresh.await_args.kwargs["end"] == last_line + timedelta(microseconds=1)
    engine.dispose.assert_awaited()
