"""CLI plugin registration and command surface."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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
    *, null_rows: int, distinct_ips: list[str], rowcount: int
) -> MagicMock:
    """Engine for the backfill-asn flow, dispatching on SQL substrings.

    connect() answers the EXISTS probe, the count/bounds scan, and the
    keyset-paginated distinct-IP stream (one page, then empty, so the
    pagination loop terminates); begin() serves the temp-table writes and
    reports ``rowcount`` on the join UPDATE.
    """
    from datetime import datetime, timezone

    ip_pages = [[SimpleNamespace(ip_text=ip) for ip in distinct_ips], []]

    def _result_for(sql: str) -> MagicMock:
        result = MagicMock()
        result.rowcount = rowcount
        if "EXISTS" in sql and "pg_extension" in sql:
            result.scalar.return_value = False  # no timescale: skip decompress
        elif "EXISTS" in sql:
            result.scalar.return_value = null_rows > 0
        elif "COUNT(DISTINCT" in sql:
            result.one.return_value = (null_rows, len(distinct_ips))
        elif "MIN(timestamp)" in sql:
            result.one.return_value = (
                datetime(2026, 1, 1, tzinfo=timezone.utc),
                datetime(2026, 1, 2, tzinfo=timezone.utc),
            )
        elif "DISTINCT ip_address" in sql:
            result.all.return_value = ip_pages.pop(0) if ip_pages else []
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


def test_backfill_asn_stamps_and_refreshes(monkeypatch) -> None:
    """1.128.0.0 resolves via the test db; the run updates and refreshes."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(monkeypatch, engine, ["--yes"], refresh)

    assert result.exit_code == 0, result.output
    assert "rows updated: 7" in result.output
    refresh.assert_awaited_once()
    assert refresh.await_args is not None
    assert refresh.await_args.kwargs["caggs"] == ["asn_hourly_stats", "asn_daily_stats"]


def test_backfill_asn_nothing_to_do(monkeypatch) -> None:
    engine = _make_asn_engine(null_rows=0, distinct_ips=[], rowcount=0)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(monkeypatch, engine, ["--yes"], refresh)

    assert result.exit_code == 0, result.output
    assert "Nothing to do" in result.output
    refresh.assert_not_awaited()


def test_backfill_asn_aborts_without_confirmation(monkeypatch) -> None:
    """Default (no --yes, input 'n'): no write transaction, no refresh."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    engine.begin = MagicMock(side_effect=AssertionError("begin() must not run when aborted"))
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(monkeypatch, engine, [], refresh, cli_input="n\n")

    assert result.exit_code == 0, result.output
    assert "Aborted" in result.output
    refresh.assert_not_awaited()


def test_backfill_asn_fails_without_asn_database(monkeypatch) -> None:
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=[])

    result = _invoke_backfill_asn(
        monkeypatch, engine, ["--yes"], refresh,
        asn_db_path="/nonexistent/GeoLite2-ASN.mmdb",
    )

    assert result.exit_code != 0
    assert "No GeoLite2 ASN database" in result.output


def test_backfill_asn_exits_nonzero_when_cagg_refresh_fails(monkeypatch) -> None:
    """Rows are stamped but the aggregates stayed stale: the run must not
    report success, or long-range analytics silently miss the backfill."""
    engine = _make_asn_engine(null_rows=7, distinct_ips=["1.128.0.0"], rowcount=7)
    refresh = AsyncMock(return_value=["asn_daily_stats"])

    result = _invoke_backfill_asn(monkeypatch, engine, ["--yes"], refresh)

    assert result.exit_code != 0
    assert "rows updated: 7" in result.output
    assert "asn_daily_stats" in result.output


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
