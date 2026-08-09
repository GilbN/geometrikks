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
