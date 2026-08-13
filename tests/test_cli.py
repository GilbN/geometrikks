"""CLI plugin registration and command surface."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from click.testing import CliRunner


def test_cli_plugin_registers_command() -> None:
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "import-logs" in cli.commands


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
