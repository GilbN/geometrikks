"""CLI plugin registration and command surface."""
from __future__ import annotations

from click.testing import CliRunner


def test_cli_plugin_registers_command():
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    assert "import-logs" in cli.commands


def test_import_logs_help_runs_without_app():
    """--help must not construct settings/engine (import-time safety)."""
    import click
    from geometrikks.cli import ImportLogsCLIPlugin

    @click.group()
    def cli() -> None: ...

    ImportLogsCLIPlugin().on_cli_init(cli)
    result = CliRunner().invoke(cli, ["import-logs", "--help"])
    assert result.exit_code == 0
    assert "--force" in result.output
