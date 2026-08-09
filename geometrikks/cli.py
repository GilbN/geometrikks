"""Litestar CLI plugin: `litestar import-logs <paths...>`, `litestar backfill-hostname NAME`.

Import-time safe: settings, engine, reader are constructed inside the
command callback, never at module import.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from pathlib import Path

import click
from litestar.plugins import CLIPlugin


@click.command(name="import-logs")
@click.argument(
    "paths",
    nargs=-1,
    required=True,
    type=click.Path(exists=True, dir_okay=False, readable=True, path_type=Path),
)
@click.option("--force", is_flag=True, help="Re-import files whose checksum was already imported (updates the prior import_jobs row; does NOT remove previously imported rows).")
@click.option("--batch-size", default=500, show_default=True, type=click.IntRange(min=1), help="Records per commit batch.")
@click.option(
    "--format",
    "log_format",
    default="auto",
    show_default=True,
    type=click.Choice(["auto", "nginx", "traefik-json"]),
    help="Log format of the given files (auto = detect per file).",
)
def import_logs_command(paths: tuple[Path, ...], force: bool, batch_size: int, log_format: str) -> None:
    """Import historical access-log files (plain or .gz) into the database.

    Reads whole files, uses log-line timestamps, refreshes the continuous
    aggregates for the imported time range afterwards. Re-importing a file
    that is also being live-tailed will double-count — import archived
    (rotated) files only.
    """
    asyncio.run(_run_import(list(paths), force=force, batch_size=batch_size, log_format=log_format))


async def _run_import(paths: list[Path], *, force: bool, batch_size: int, log_format: str) -> None:
    from geoip2.database import Reader

    from geometrikks.config.settings import get_settings
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range
    from geometrikks.services.importer import UnrecognizedLogFormatError, import_file
    from geometrikks.services.ingestion.service import LogIngestionService, create_reader
    from geometrikks.services.logparser.logparser import LogParser

    settings = get_settings()
    config = get_sqlalchemy_config()
    engine = config.get_engine()
    session_maker = config.create_session_maker()

    reader: Reader | None = create_reader(settings.geoip.db_path, settings.geoip.locales)
    if reader is None:
        await engine.dispose()
        raise click.ClickException(
            f"No GeoIP database at {settings.geoip.db_path} — cannot import. "
            "Configure GEOIP_ACCOUNT_ID/GEOIP_LICENSE_KEY and start the app "
            "once to auto-download, or provide the mmdb manually."
        )

    service = LogIngestionService(
        parsers=[],
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        hostname=settings.logparser.host_name,
        store_debug_lines=settings.logparser.store_debug_lines,
    )

    overall_start: datetime | None = None
    overall_end: datetime | None = None
    failed: list[Path] = []
    try:
        for path in paths:
            click.echo(f"Importing {path} ...")
            parser = LogParser(
                log_path=path,
                send_logs=settings.logparser.send_logs,
                ignore_ips=settings.logparser.ignore_ips,
                log_format=log_format,
            )

            def show_progress(lines: int, lps: float) -> None:
                click.echo(f"  {lines:>12,} lines  ({lps:,.0f} lines/s)")

            try:
                result = await import_file(
                    path,
                    service=service,
                    parser=parser,
                    reader=reader,
                    session_maker=session_maker,
                    batch_size=batch_size,
                    force=force,
                    progress=show_progress,
                )
            except UnrecognizedLogFormatError as exc:
                click.echo(f"  error: {exc}", err=True)
                failed.append(path)
                continue

            if result.skipped:
                click.echo("  skipped: already imported (use --force to re-import)")
                continue

            click.echo(
                f"  done: {result.lines_total:,} lines "
                f"({result.lines_skipped:,} skipped as unparseable), "
                f"{result.records_written:,} records "
                f"in {result.duration_seconds:,.1f}s "
                f"({result.lines_total / result.duration_seconds:,.0f} lines/s)"
            )
            if result.time_start and result.time_end:
                overall_start = (
                    result.time_start
                    if overall_start is None
                    else min(overall_start, result.time_start)
                )
                overall_end = (
                    result.time_end if overall_end is None else max(overall_end, result.time_end)
                )

        if overall_start and overall_end:
            click.echo(f"Refreshing continuous aggregates {overall_start} → {overall_end} ...")
            await refresh_caggs_range(
                engine, start=overall_start, end=overall_end + timedelta(microseconds=1)
            )
            click.echo("CAGGs refreshed.")
    finally:
        await engine.dispose()
        reader.close()

    if failed:
        raise click.ClickException(
            f"{len(failed)} file(s) not imported: " + ", ".join(str(p) for p in failed)
        )


@click.command(name="backfill-hostname")
@click.argument("name")
@click.option(
    "--consolidate", is_flag=True,
    help=(
        "Also rewrite ALL existing hostnames (geo_events and stamped "
        "access_logs rows) to NAME. For DBs polluted by Docker container-ID "
        "hostnames from unset LOGPARSER_HOST_NAME."
    ),
)
@click.option("--yes", is_flag=True, help="Skip the confirmation prompt.")
def backfill_hostname_command(name: str, consolidate: bool, yes: bool) -> None:
    """Set the recording hostname on historical rows.

    Default: fills only access_logs rows with NULL hostname (idempotent,
    cannot clobber stamped data). With --consolidate it collapses every
    existing hostname in geo_events and access_logs to NAME as well.
    May run for minutes on large databases.
    """
    asyncio.run(_run_backfill_hostname(name, consolidate=consolidate, yes=yes))


async def _run_backfill_hostname(name: str, *, consolidate: bool, yes: bool) -> None:
    from sqlalchemy import text

    from geometrikks.server.logging import get_logger
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range

    logger = get_logger(__name__)
    config = get_sqlalchemy_config()
    engine = config.get_engine()
    try:
        async with engine.connect() as conn:
            distinct = (await conn.execute(text(
                "SELECT hostname, COUNT(*) FROM geo_events GROUP BY hostname ORDER BY hostname"
            ))).all()

        if consolidate:
            click.echo("Hostnames that will be consolidated into "
                       f"{name!r} (geo_events counts):")
            for host, count in distinct:
                click.echo(f"  {host}: {count:,}")
            if not yes and not click.confirm("Rewrite ALL of these?"):
                click.echo("Aborted.")
                return

        async with engine.begin() as conn:
            filled = (await conn.execute(
                text("UPDATE access_logs SET hostname = :n WHERE hostname IS NULL"),
                {"n": name},
            )).rowcount
            rewritten_geo = rewritten_logs = 0
            if consolidate:
                rewritten_geo = (await conn.execute(
                    text("UPDATE geo_events SET hostname = :n WHERE hostname <> :n"),
                    {"n": name},
                )).rowcount
                rewritten_logs = (await conn.execute(
                    text("UPDATE access_logs SET hostname = :n "
                         "WHERE hostname IS NOT NULL AND hostname <> :n"),
                    {"n": name},
                )).rowcount

        click.echo(f"access_logs NULL hostnames filled: {filled:,}")
        if consolidate:
            click.echo(f"geo_events hostnames rewritten: {rewritten_geo:,}")
            click.echo(f"access_logs hostnames rewritten: {rewritten_logs:,}")

            # The hostname CAGGs still show the old values until refreshed.
            bounds = None
            async with engine.connect() as conn:
                bounds = (await conn.execute(text(
                    "SELECT MIN(timestamp), MAX(timestamp) FROM geo_events"
                ))).one()
            if bounds and bounds[0] is not None:
                click.echo("Refreshing hostname CAGGs ...")
                await refresh_caggs_range(
                    engine, start=bounds[0], end=bounds[1] + timedelta(microseconds=1),
                    caggs=["hostname_daily_stats", "log_source_daily_stats"],
                )

        logger.info(
            "hostname_backfill_completed name=%s consolidate=%s filled=%d rewritten_geo=%d rewritten_logs=%d",
            name, consolidate, filled, rewritten_geo, rewritten_logs,
        )
    finally:
        await engine.dispose()


class ImportLogsCLIPlugin(CLIPlugin):
    """Registers import-logs and backfill-hostname on the litestar CLI group."""

    def on_cli_init(self, cli: click.Group) -> None:
        cli.add_command(import_logs_command)
        cli.add_command(backfill_hostname_command)
