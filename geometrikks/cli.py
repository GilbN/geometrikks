"""Litestar CLI commands for log imports and historical data backfills.

Import-time safe: settings, engine, reader are constructed inside the
command callback, never at module import. The format registry import
loads the logparser package but constructs none of those.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import click
from litestar.plugins import CLIPlugin

from geometrikks.services.logparser.formats import IMPORT_FORMATS

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings


_DATETIME_FORMATS = [
    "%Y-%m-%d",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S.%f%z",
]


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
    type=click.Choice(["auto", *IMPORT_FORMATS]),
    help="Log format of the given files (auto = detect per file).",
)
@click.option(
    "--hostname",
    default=None,
    help=(
        "Source hostname stamped on imported records. Default: the hostname of "
        "the first tailed file, or of the first Loki query when no file is tailed."
    ),
)
@click.option(
    "--before",
    default=None,
    type=click.DateTime(formats=_DATETIME_FORMATS),
    help=(
        "Only import lines older than this date or datetime. Without an "
        "offset it is UTC. Use the first timestamp of a log that is already "
        "being ingested, so the import doesn't overlap it. A file imported "
        "earlier with an earlier --before gets only the lines in between."
    ),
)
def import_logs_command(
    paths: tuple[Path, ...],
    force: bool,
    batch_size: int,
    log_format: str,
    hostname: str | None,
    before: datetime | None,
) -> None:
    """Import historical access-log files (plain or .gz) into the database.

    Reads whole files, uses log-line timestamps, refreshes the continuous
    aggregates for the imported time range afterwards. Re-importing a file
    that is also being live-tailed will double-count — import archived
    (rotated) files only.
    """
    if hostname is not None:
        hostname = hostname.strip()
        if not hostname:
            raise click.BadParameter("must not be blank", param_hint="'--hostname'")
    if before is not None and before.tzinfo is None:
        before = before.replace(tzinfo=timezone.utc)
    asyncio.run(
        _run_import(
            list(paths),
            force=force,
            batch_size=batch_size,
            log_format=log_format,
            hostname=hostname,
            before=before,
        )
    )


async def _run_import(
    paths: list[Path],
    *,
    force: bool,
    batch_size: int,
    log_format: str,
    hostname: str | None,
    before: datetime | None,
) -> None:
    from geoip2.database import Reader

    from geometrikks.config.settings import get_settings
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range
    from geometrikks.services.importer import (
        ImportCutoffConflictError,
        UnrecognizedLogFormatError,
        import_file,
    )
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

    asn_reader: Reader | None = (
        create_reader(settings.geoip.asn_db_path) if settings.geoip.asn_enabled else None
    )
    if settings.geoip.asn_enabled and asn_reader is None:
        click.echo("No GeoLite2 ASN database found; importing without ASN enrichment.")

    effective_hostname = hostname or settings.ingest_server_names()[0]
    click.echo(f"Stamping hostname: {effective_hostname}")
    service = LogIngestionService(
        inputs=[],
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        hostname=effective_hostname,
        store_debug_lines=settings.logparser.store_debug_lines,
    )

    overall_start: datetime | None = None
    overall_end: datetime | None = None
    failed: list[Path] = []
    refresh_failed: list[str] = []
    try:
        for path in paths:
            click.echo(f"Importing {path} ...")
            parser = LogParser(
                source_label=str(path),
                send_logs=settings.logparser.send_logs,
                ignore_ips=settings.logparser.ignore_ips,
                log_format=log_format,
                formats=IMPORT_FORMATS,
            )

            def show_progress(lines: int, lps: float) -> None:
                click.echo(f"  {lines:>12,} lines  ({lps:,.0f} lines/s)")

            try:
                result = await import_file(
                    path,
                    service=service,
                    parser=parser,
                    reader=reader,
                    asn_reader=asn_reader,
                    session_maker=session_maker,
                    batch_size=batch_size,
                    force=force,
                    before=before,
                    progress=show_progress,
                )
            except (UnrecognizedLogFormatError, ImportCutoffConflictError) as exc:
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
            if result.lines_after_cutoff:
                click.echo(f"  {result.lines_after_cutoff:,} lines at or after --before left out")
            if result.lines_already_imported:
                click.echo(
                    f"  {result.lines_already_imported:,} lines left out that an earlier "
                    "run with an earlier --before already imported"
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
            refresh_failed = await refresh_caggs_range(
                engine, start=overall_start, end=overall_end + timedelta(microseconds=1)
            )
            if not refresh_failed:
                click.echo("CAGGs refreshed.")
    finally:
        await engine.dispose()
        reader.close()
        if asn_reader is not None:
            asn_reader.close()

    problems: list[str] = []
    if failed:
        problems.append(
            f"{len(failed)} file(s) not imported: " + ", ".join(str(p) for p in failed)
        )
    if refresh_failed:
        problems.append(
            f"Rows were imported, but refreshing {', '.join(refresh_failed)} failed, so "
            "analytics won't show the imported range in those views yet. The warnings "
            "above give the reason."
        )
    if problems:
        raise click.ClickException("\n".join(problems))


@click.command(name="import-loki")
@click.option(
    "--since",
    required=True,
    type=click.DateTime(formats=_DATETIME_FORMATS),
    help="Start of the range to import, inclusive. Without an offset it is UTC.",
)
@click.option(
    "--before",
    default=None,
    type=click.DateTime(formats=_DATETIME_FORMATS),
    help=(
        "End of the range, exclusive. Without an offset it is UTC. Default: where "
        "the data already in the database begins. That is the oldest access-log "
        "row for the selector's hostname, or, after an earlier import-loki run, "
        "that run's start unless older access-log rows exist. An interrupted run "
        "with the same --since keeps its own end."
    ),
)
@click.option(
    "--query",
    "query_index",
    default=None,
    type=click.IntRange(min=1),
    help="Only the Nth selector in LOKI_QUERIES, counting from 1. Default: all of them.",
)
@click.option("--force", is_flag=True, help="Skip the overlap check. An unfinished run of the same range still resumes. A finished range is imported again, and the rows from the first import stay.")
@click.option("--batch-size", default=500, show_default=True, type=click.IntRange(min=1), help="Records per commit batch.")
def import_loki_command(
    since: datetime,
    before: datetime | None,
    query_index: int | None,
    force: bool,
    batch_size: int,
) -> None:
    """Import a time range of each LOKI_QUERIES selector into the database.

    Reads Loki one hour at a time through the live pipeline, stamps rows
    with the time in each log line, and refreshes the continuous aggregates
    for the imported range at the end. Rerunning the same range resumes
    where an interrupted run stopped. Refuses a range that overlaps an
    earlier import.
    """
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    if before is not None and before.tzinfo is None:
        before = before.replace(tzinfo=timezone.utc)
    if before is not None and since >= before:
        raise click.BadParameter("must be earlier than --before", param_hint="'--since'")
    asyncio.run(
        _run_loki_import(
            since=since,
            before=before,
            query_index=query_index,
            force=force,
            batch_size=batch_size,
        )
    )


def select_loki_queries(
    settings: "Settings", query_index: int | None
) -> list[tuple[int, str, str, str]]:
    """(position, selector, format, hostname) for every selector, or the one asked for."""
    loki = settings.loki
    if loki.url is None or not loki.queries:
        raise click.ClickException(
            "LOKI_URL or LOKI_QUERIES is not set, so there is no Loki source to import from."
        )
    if query_index is not None and not 1 <= query_index <= len(loki.queries):
        raise click.ClickException(
            f"--query {query_index}: LOKI_QUERIES has {len(loki.queries)} selector(s)."
        )
    selected = list(
        enumerate(
            zip(
                loki.queries,
                loki.resolved_formats(),
                loki.resolved_server_names(settings.logparser.server_name[0]),
            ),
            start=1,
        )
    )
    if query_index is not None:
        selected = [selected[query_index - 1]]
    return [(index, query, fmt, host) for index, (query, fmt, host) in selected]


def resolve_loki_before(
    *,
    since: datetime,
    before: datetime | None,
    oldest_row: datetime | None,
    earliest_import: datetime | None,
    unfinished_end: datetime | None,
    imports_wrote_from: datetime | None,
    hostname: str,
) -> datetime:
    """The end of the range: as given, an unfinished run's end, or the start of what is covered."""
    if before is not None:
        return before
    if unfinished_end is not None:
        return unfinished_end
    covered_from = [moment for moment in (oldest_row, earliest_import) if moment is not None]
    if not covered_from:
        raise click.ClickException(
            f"no access-log rows or earlier imports exist for hostname {hostname}, so there "
            "is no default end for the range. Pass --before."
        )
    # The oldest row may be a line an import wrote. The proxy stamped that line a
    # shipper's delay before Loki stamped its entry, so the import's own start is
    # the exact boundary.
    if (
        earliest_import is not None
        and oldest_row is not None
        and imports_wrote_from is not None
        and oldest_row >= imports_wrote_from
    ):
        end = earliest_import
    else:
        end = min(covered_from)
    if since >= end:
        raise click.ClickException(
            f"--since {since.isoformat()} is not before {end.isoformat()}, where an "
            f"earlier import or the stored rows for {hostname} already begin. Pass an "
            "earlier --since to go further back. To import a later range on purpose, "
            "pass --before, plus --force if that range was imported already."
        )
    return end


async def _covered_from(
    session_maker: Callable[[], AsyncSession],
    *,
    url: str,
    tenant_id: str | None,
    query: str,
    since: datetime,
    hostname: str,
) -> tuple[datetime | None, datetime | None, datetime | None, datetime | None]:
    """For a selector: (oldest stored row, earliest import start, unfinished run's end,
    earliest log-line time any import wrote for the hostname).
    """
    from sqlalchemy import func, select

    from geometrikks.domain.imports.repositories import LokiImportRepository
    from geometrikks.domain.logs.models import AccessLog

    async with session_maker() as session:
        oldest_row = await session.scalar(
            select(func.min(AccessLog.timestamp)).where(AccessLog.hostname == hostname)
        )
        repo = LokiImportRepository(session=session)
        identity = {"url": url, "tenant_id": tenant_id, "query": query}
        earliest_import = await repo.earliest_range_start(**identity)
        unfinished = await repo.find_unfinished(since=since, **identity)
        imports_wrote_from = await repo.earliest_written_line(hostname=hostname)
        return (
            oldest_row,
            earliest_import,
            unfinished.range_end if unfinished else None,
            imports_wrote_from,
        )


async def _written_span(
    session_maker: Callable[[], AsyncSession],
    *,
    url: str,
    tenant_id: str | None,
    query: str,
    since: datetime,
    before: datetime,
) -> tuple[datetime | None, datetime | None]:
    """(time_start, time_end) of what the selector's unfinished run of [since, before) wrote."""
    from geometrikks.domain.imports.repositories import LokiImportRepository
    from geometrikks.server.logging import get_logger

    try:
        async with session_maker() as session:
            unfinished = await LokiImportRepository(session=session).find_resumable(
                url=url, tenant_id=tenant_id, query=query, since=since, before=before
            )
    except Exception:
        get_logger(__name__).warning("loki_import_bounds_unavailable", query=query)
        return None, None
    if unfinished is None:
        return None, None
    return unfinished.time_start, unfinished.time_end


async def _run_loki_import(
    *,
    since: datetime,
    before: datetime | None,
    query_index: int | None,
    force: bool,
    batch_size: int,
) -> None:
    import httpx2
    from geoip2.database import Reader

    from geometrikks.config.settings import get_settings
    from geometrikks.server.logging import get_logger
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range
    from geometrikks.services.importer import UnrecognizedLogFormatError
    from geometrikks.services.ingestion.service import LogIngestionService, create_reader
    from geometrikks.services.loki_importer import (
        LokiImportOverlapError,
        LokiImportProgress,
        LokiImportWriteError,
        claim_loki_range,
        import_loki_range,
    )
    from geometrikks.services.logparser.logparser import LogParser
    from geometrikks.services.logsources.loki import LokiRejected, LokiSource

    logger = get_logger(__name__)
    settings = get_settings()
    selected = select_loki_queries(settings, query_index)
    loki = settings.loki
    assert loki.url is not None  # select_loki_queries refused the unset case
    password = loki.password.get_secret_value() if loki.password is not None else None

    config = get_sqlalchemy_config()
    engine = config.get_engine()
    session_maker = config.create_session_maker()

    reader: Reader | None = create_reader(settings.geoip.db_path, settings.geoip.locales)
    if reader is None:
        await engine.dispose()
        raise click.ClickException(
            f"No GeoIP database at {settings.geoip.db_path}, cannot import. "
            "Configure GEOIP_ACCOUNT_ID/GEOIP_LICENSE_KEY and start the app "
            "once to auto-download, or provide the mmdb manually."
        )
    asn_reader: Reader | None = (
        create_reader(settings.geoip.asn_db_path) if settings.geoip.asn_enabled else None
    )
    if settings.geoip.asn_enabled and asn_reader is None:
        click.echo("No GeoLite2 ASN database found; importing without ASN enrichment.")

    service = LogIngestionService(
        inputs=[],
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        hostname=settings.logparser.server_name[0],
        store_debug_lines=settings.logparser.store_debug_lines,
    )

    overall_start: datetime | None = None
    overall_end: datetime | None = None
    failed: list[str] = []
    refresh_failed: list[str] = []

    def fold_bounds(time_start: datetime | None, time_end: datetime | None) -> None:
        nonlocal overall_start, overall_end
        if time_start and time_end:
            overall_start = time_start if overall_start is None else min(overall_start, time_start)
            overall_end = time_end if overall_end is None else max(overall_end, time_end)

    try:
        ends: list[datetime | None] = []
        for _, query, _, host in selected:
            try:
                covered = (None, None, None, None)
                if before is None:
                    covered = await _covered_from(
                        session_maker,
                        url=loki.url,
                        tenant_id=loki.tenant_id,
                        query=query,
                        since=since,
                        hostname=host,
                    )
                oldest_row, earliest_import, unfinished_end, imports_wrote_from = covered
                ends.append(
                    resolve_loki_before(
                        since=since,
                        before=before,
                        oldest_row=oldest_row,
                        earliest_import=earliest_import,
                        unfinished_end=unfinished_end,
                        imports_wrote_from=imports_wrote_from,
                        hostname=host,
                    )
                )
            except click.ClickException as exc:
                click.echo(f"{query}: {exc.message}", err=True)
                failed.append(query)
                ends.append(None)

        sources = [
            LokiSource(
                url=loki.url,
                query=query,
                label=f"loki:{index}",
                hostname=host,
                tenant_id=loki.tenant_id,
                username=loki.username,
                password=password,
            )
            for index, query, _, host in selected
        ]
        for position, (source, end) in enumerate(zip(sources, ends, strict=True)):
            if end is None:
                continue
            try:
                await claim_loki_range(
                    source, session_maker=session_maker, since=since, before=end, force=force
                )
            except LokiImportOverlapError as exc:
                click.echo(f"  error: {exc}", err=True)
                failed.append(source.query)
                ends[position] = None

        for (_, query, fmt, host), source, end in zip(selected, sources, ends, strict=True):
            if end is None:
                continue
            click.echo(f"Importing {query} (hostname {host}) ...")
            if before is None:
                click.echo(
                    f"  --before not given, stopping at {end.isoformat()}. To rerun this "
                    f"range: --since {since.isoformat()} --before {end.isoformat()}"
                )
            click.echo(f"  range {since.isoformat()} to {end.isoformat()}")

            parser = LogParser(
                source_label=f"loki:{query}",
                send_logs=settings.logparser.send_logs,
                ignore_ips=settings.logparser.ignore_ips,
                log_format=fmt,
                formats=IMPORT_FORMATS,
            )

            def show_progress(report: LokiImportProgress) -> None:
                click.echo(
                    f"  {report.day.isoformat()}  {report.lines_total:>12,} lines  "
                    f"{report.records_written:>12,} records  ({report.lines_per_second:,.0f} lines/s)"
                )

            try:
                result = await import_loki_range(
                    source,
                    service=service,
                    parser=parser,
                    reader=reader,
                    asn_reader=asn_reader,
                    session_maker=session_maker,
                    since=since,
                    before=end,
                    batch_size=batch_size,
                    force=force,
                    progress=show_progress,
                )
            except (UnrecognizedLogFormatError, LokiImportOverlapError) as exc:
                click.echo(f"  error: {exc}", err=True)
                failed.append(query)
                continue
            except LokiImportWriteError as exc:
                click.echo(
                    f"  error: {exc}. That hour is not marked as imported, so rerunning "
                    "with the same --since and --before resumes from it.",
                    err=True,
                )
                failed.append(query)
                written_from, written_to = await _written_span(
                    session_maker,
                    url=loki.url,
                    tenant_id=loki.tenant_id,
                    query=query,
                    since=since,
                    before=end,
                )
                fold_bounds(written_from, written_to)
                continue
            except (httpx2.HTTPError, LokiRejected) as exc:
                click.echo(
                    f"  error: Loki failed with {exc!r}. Rerun with the same --since and "
                    "--before to resume.",
                    err=True,
                )
                failed.append(query)
                written_from, written_to = await _written_span(
                    session_maker,
                    url=loki.url,
                    tenant_id=loki.tenant_id,
                    query=query,
                    since=since,
                    before=end,
                )
                fold_bounds(written_from, written_to)
                continue
            except Exception as exc:
                logger.exception("loki_import_selector_failed", query=query)
                click.echo(
                    f"  error: {exc!r}. Progress up to the last completed hour is kept. "
                    "Rerun with the same --since and --before to resume.",
                    err=True,
                )
                failed.append(query)
                continue

            if result.resumed_from is not None:
                click.echo(f"  resumed from {result.resumed_from.isoformat()}")
            click.echo(
                f"  done: {result.lines_total:,} lines "
                f"({result.lines_skipped:,} skipped as ignored or unparseable), "
                f"{result.records_written:,} records "
                f"in {result.duration_seconds:,.1f}s"
            )
            fold_bounds(result.time_start, result.time_end)

        if overall_start and overall_end:
            click.echo(f"Refreshing continuous aggregates {overall_start} to {overall_end} ...")
            refresh_failed = await refresh_caggs_range(
                engine, start=overall_start, end=overall_end + timedelta(microseconds=1)
            )
            if not refresh_failed:
                click.echo("CAGGs refreshed.")
    finally:
        await engine.dispose()
        reader.close()
        if asn_reader is not None:
            asn_reader.close()

    problems: list[str] = []
    if failed:
        problems.append(f"{len(failed)} selector(s) not imported: " + "; ".join(failed))
    if refresh_failed:
        problems.append(
            f"Rows were imported, but refreshing {', '.join(refresh_failed)} failed, so "
            "analytics won't show the imported range in those views yet. The warnings "
            "above give the reason."
        )
    if problems:
        raise click.ClickException("\n".join(problems))


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
    Refreshes the hostname continuous aggregates whenever rows changed.
    Compressed hypertable chunks are decompressed first (a full-table
    UPDATE would trip the TimescaleDB tuple decompression limit); the
    compression policy recompresses them later. May run for minutes on
    large databases.
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
                "SELECT server, COUNT(*) FROM geo_events GROUP BY server ORDER BY server"
            ))).all()

        if consolidate:
            click.echo("Hostnames that will be consolidated into "
                       f"{name!r} (geo_events counts):")
            for host, count in distinct:
                click.echo(f"  {host}: {count:,}")
            if not yes and not click.confirm("Rewrite ALL of these?"):
                click.echo("Aborted.")
                return

        # Cheap EXISTS probes (server is indexed) so a rerun with nothing
        # left to change exits before the expensive decompression below.
        async with engine.connect() as conn:
            async def _exists(sql: str) -> bool:
                return bool((await conn.execute(text(sql), {"n": name})).scalar())

            needs_fill = await _exists(
                "SELECT EXISTS (SELECT 1 FROM access_logs WHERE server IS NULL)")
            needs_logs_rewrite = consolidate and await _exists(
                "SELECT EXISTS (SELECT 1 FROM access_logs "
                "WHERE server IS NOT NULL AND server <> :n)")
            needs_geo_rewrite = consolidate and await _exists(
                "SELECT EXISTS (SELECT 1 FROM geo_events WHERE server <> :n)")
            timescale = await _exists(
                "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')")

        if not (needs_fill or needs_logs_rewrite or needs_geo_rewrite):
            click.echo("Nothing to do: no NULL hostnames"
                       + (" and nothing to consolidate" if consolidate else "") + ".")
            return

        # Full-table UPDATEs on compressed hypertable chunks trip
        # timescaledb.max_tuples_decompressed_per_dml_transaction (100k by
        # default, vs millions of historical rows). Decompress first, same
        # pattern as the url/referrer swap migration; the compression policy
        # recompresses on its own schedule.
        if timescale:
            tables = []
            if needs_fill or needs_logs_rewrite:
                tables.append("access_logs")
            if needs_geo_rewrite:
                tables.append("geo_events")
            for table in tables:
                click.echo(f"Decompressing compressed {table} chunks ...")
                async with engine.begin() as conn:
                    await conn.execute(text(
                        "SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true) "
                        "FROM timescaledb_information.chunks "
                        "WHERE hypertable_name = :t AND is_compressed"
                    ), {"t": table})

        async with engine.begin() as conn:
            filled = (await conn.execute(
                text("UPDATE access_logs SET server = :n WHERE server IS NULL"),
                {"n": name},
            )).rowcount
            rewritten_geo = rewritten_logs = 0
            if consolidate:
                rewritten_geo = (await conn.execute(
                    text("UPDATE geo_events SET server = :n WHERE server <> :n"),
                    {"n": name},
                )).rowcount
                rewritten_logs = (await conn.execute(
                    text("UPDATE access_logs SET server = :n "
                         "WHERE server IS NOT NULL AND server <> :n"),
                    {"n": name},
                )).rowcount

        click.echo(f"access_logs NULL hostnames filled: {filled:,}")
        if consolidate:
            click.echo(f"geo_events hostnames rewritten: {rewritten_geo:,}")
            click.echo(f"access_logs hostnames rewritten: {rewritten_logs:,}")

        # The server CAGGs still show the old values until refreshed. The
        # plain fill path needs this too: without it log_source_daily_stats
        # keeps server NULL for history, and once raw retention drops the
        # access_logs rows the facet can never be corrected.
        # Ranges are computed per source table: server_daily_stats reads
        # geo_events while log_source_daily_stats reads access_logs, and
        # the two tables' time bounds differ (access logs exist for rows
        # that never produced a geo event).
        if filled or rewritten_geo or rewritten_logs:
            click.echo("Refreshing hostname CAGGs ...")
            async with engine.connect() as conn:
                for table, cagg in (
                    ("geo_events", "server_daily_stats"),
                    ("access_logs", "log_source_daily_stats"),
                ):
                    bounds = (await conn.execute(text(
                        f"SELECT MIN(timestamp), MAX(timestamp) FROM {table}"
                    ))).one()
                    if bounds[0] is not None:
                        await refresh_caggs_range(
                            engine, start=bounds[0],
                            end=bounds[1] + timedelta(microseconds=1),
                            caggs=[cagg],
                        )

        logger.info(
            "hostname_backfill_completed",
            name=name,
            consolidate=consolidate,
            filled=filled,
            rewritten_geo=rewritten_geo,
            rewritten_logs=rewritten_logs,
        )
    finally:
        await engine.dispose()


ASN_BACKFILL_CHUNK_SIZE = 10_000
ASN_BACKFILL_TABLES = ("access_logs", "geo_events")
ASN_BACKFILL_TARGETS = {
    "access-logs": ("access_logs",),
    "geo-events": ("geo_events",),
    "all": ASN_BACKFILL_TABLES,
}


@click.command(name="backfill-asn")
@click.option(
    "--table",
    "target",
    type=click.Choice(tuple(ASN_BACKFILL_TARGETS)),
    required=True,
    help="Table to backfill. Use geo-events for historical Geo Logs.",
)
@click.option("--yes", is_flag=True, help="Skip the confirmation prompt.")
def backfill_asn_command(target: str, yes: bool) -> None:
    """Stamp ASN data onto historical rows from the current ASN database.

    Use --table access-logs for Access Logs, --table geo-events for historical
    Geo Logs, or --table all to process both tables. Only rows with a NULL
    autonomous_system_number are updated. IPs the database cannot resolve stay
    NULL. The command refreshes the affected continuous aggregates when rows
    changed.
    Compressed hypertable chunks are decompressed first (a full-table
    UPDATE would trip the TimescaleDB tuple decompression limit); the
    compression policy recompresses them later. May run for minutes on
    large databases.
    """
    asyncio.run(_run_backfill_asn(yes=yes, tables=ASN_BACKFILL_TARGETS[target]))


async def _iter_null_asn_ips(
    engine, *, table: str = "access_logs", chunk_size: int = ASN_BACKFILL_CHUNK_SIZE
):
    """Yield distinct NULL-ASN client IPs of ``table`` in keyset-paginated chunks.

    Keyset pagination on the inet column (OFFSET would rescan) holds one
    chunk in memory at a time; on an internet-facing install the distinct-IP
    count can approach the row count.
    """
    from sqlalchemy import text

    if table not in ASN_BACKFILL_TABLES:
        raise ValueError(f"Unsupported backfill table: {table!r}")
    last: str | None = None
    while True:
        where = "autonomous_system_number IS NULL"
        params: dict = {"lim": chunk_size}
        if last is not None:
            where += " AND ip_address > CAST(:last AS inet)"
            params["last"] = last
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                f"SELECT DISTINCT ip_address, host(ip_address) AS ip_text "
                f"FROM {table} WHERE {where} "  # noqa: S608 - allowlisted identifier
                f"ORDER BY ip_address LIMIT :lim"
            ), params)).all()
        if not rows:
            return
        yield [row.ip_text for row in rows]
        last = rows[-1].ip_text


async def _apply_asn_mapping(engine, chunks, *, table: str = "access_logs") -> int:
    """Stream ip -> (asn, org) chunks into a temp table, then one join UPDATE on ``table``.

    One transaction, so the ON COMMIT DROP temp table spans every chunk
    while only the chunk in flight is held. Returns the UPDATE rowcount.
    ``chunks`` is a list of mapping dicts (one chunk) or an async iterable
    of them. Kept separate from _run_backfill_asn so the integration tests
    can run the SQL against a real database.
    """
    from sqlalchemy import text

    if table not in ASN_BACKFILL_TABLES:
        raise ValueError(f"Unsupported backfill table: {table!r}")
    if isinstance(chunks, list):
        # Bound as a default: reassigning `chunks` below would otherwise make
        # the closure yield the generator itself.
        async def _single(only=chunks):
            yield only
        chunks = _single()

    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE TEMPORARY TABLE tmp_asn_map "
            "(ip inet PRIMARY KEY, asn bigint NOT NULL, org varchar(255)) "
            "ON COMMIT DROP"
        ))
        insert = text("INSERT INTO tmp_asn_map (ip, asn, org) VALUES (:ip, :asn, :org)")
        mapped = 0
        async for chunk in chunks:
            if not chunk:
                continue
            await conn.execute(insert, chunk)
            mapped += len(chunk)
        if not mapped:
            return 0
        return (await conn.execute(text(
            f"UPDATE {table} t "  # noqa: S608 - allowlisted identifier
            "SET autonomous_system_number = m.asn, "
            "    autonomous_system_organization = m.org "
            "FROM tmp_asn_map m "
            "WHERE t.autonomous_system_number IS NULL AND t.ip_address = m.ip"
        ))).rowcount


async def _run_backfill_asn(*, yes: bool, tables: tuple[str, ...]) -> None:
    from sqlalchemy import text

    from geometrikks.config.settings import get_settings
    from geometrikks.server.logging import get_logger
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import IP_LOCATION_CAGGS_NAMES, refresh_caggs_range
    from geometrikks.services.ingestion.service import create_reader

    if not tables or any(table not in ASN_BACKFILL_TABLES for table in tables):
        raise ValueError(f"Unsupported backfill tables: {tables!r}")

    logger = get_logger(__name__)
    settings = get_settings()
    reader = create_reader(settings.geoip.asn_db_path)
    if reader is None:
        raise click.ClickException(
            f"No GeoLite2 ASN database at {settings.geoip.asn_db_path}. Start "
            "the app once with MaxMind credentials to download it, or place "
            "the mmdb there yourself."
        )

    caggs_by_table = {
        "access_logs": ["asn_hourly_stats", "asn_daily_stats"],
        "geo_events": list(IP_LOCATION_CAGGS_NAMES),
    }
    config = get_sqlalchemy_config()
    engine = config.get_engine()
    try:
        # Cheap EXISTS probes (both ASN columns are indexed) so a rerun with
        # nothing left to fill exits before the expensive scans below.
        async with engine.connect() as conn:
            needs_fill = [
                table for table in tables
                if bool((await conn.execute(text(
                    f"SELECT EXISTS (SELECT 1 FROM {table} "  # noqa: S608
                    "WHERE autonomous_system_number IS NULL)"
                ))).scalar())
            ]
            timescale = bool((await conn.execute(text(
                "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
            ))).scalar())

        if not needs_fill:
            click.echo("Nothing to do: no rows without ASN data.")
            return

        click.echo("Scanning rows without ASN data ...")
        async with engine.connect() as conn:
            for table in needs_fill:
                null_rows, distinct_ips = (await conn.execute(text(
                    f"SELECT COUNT(*), COUNT(DISTINCT ip_address) FROM {table} "  # noqa: S608
                    "WHERE autonomous_system_number IS NULL"
                ))).one()
                click.echo(f"{table}: {null_rows:,} rows across {distinct_ips:,} distinct IPs lack ASN data.")
        if not yes and not click.confirm("Backfill them from the local ASN database?"):
            click.echo("Aborted.")
            return

        from geoip2.errors import AddressNotFoundError

        updated: dict[str, int] = {}
        refresh_failed: list[str] = []
        stats = {"resolved": 0, "not_found": 0, "failed": 0}

        for table in needs_fill:
            # Bounds before the update: after it, the NULL set shrinks and the
            # refresh range for the changed rows would be lost.
            async with engine.connect() as conn:
                bounds = (await conn.execute(text(
                    f"SELECT MIN(timestamp), MAX(timestamp) FROM {table} "  # noqa: S608
                    "WHERE autonomous_system_number IS NULL"
                ))).one()

            # Decompression precedes the write: the UPDATE inside
            # _apply_asn_mapping would otherwise trip
            # timescaledb.max_tuples_decompressed_per_dml_transaction. The
            # compression policy recompresses on its own schedule.
            if timescale:
                click.echo(f"Decompressing compressed {table} chunks ...")
                async with engine.begin() as conn:
                    await conn.execute(text(
                        "SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true) "
                        "FROM timescaledb_information.chunks "
                        "WHERE hypertable_name = :table AND is_compressed"
                    ), {"table": table})

            async def _resolved_chunks(source: str = table):
                """Resolve each IP chunk as it arrives; only one is ever held."""
                async for ips in _iter_null_asn_ips(engine, table=source):
                    mapping: list[dict] = []
                    for ip in ips:
                        try:
                            asn = reader.asn(ip)
                        except AddressNotFoundError:
                            stats["not_found"] += 1
                            continue
                        except Exception:
                            # Corrupt reader state or decode errors must not abort
                            # the run, but they are not "not in the database" either.
                            stats["failed"] += 1
                            logger.debug(
                                "ASN lookup failed for %s during backfill", ip, exc_info=True
                            )
                            continue
                        org = asn.autonomous_system_organization
                        mapping.append({
                            "ip": ip,
                            "asn": asn.autonomous_system_number,
                            "org": org[:255] if org else None,
                        })
                    stats["resolved"] += len(mapping)
                    click.echo(f"  resolved {stats['resolved']:,} IPs ...")
                    yield mapping

            click.echo(f"Resolving {table} IPs against the ASN database ...")
            updated[table] = await _apply_asn_mapping(engine, _resolved_chunks(), table=table)
            click.echo(f"{table} rows updated: {updated[table]:,}")

            # The ASN and per-IP CAGGs need a refresh before the backfilled
            # history shows up. A failed refresh must fail the run: ranges
            # outside the policy window are never retried automatically.
            if updated[table] and bounds[0] is not None:
                click.echo(f"Refreshing {', '.join(caggs_by_table[table])} ...")
                refresh_failed += await refresh_caggs_range(
                    engine,
                    start=bounds[0],
                    end=bounds[1] + timedelta(microseconds=1),
                    caggs=caggs_by_table[table],
                )

        click.echo(
            f"Resolved {stats['resolved']:,} IPs "
            f"({stats['not_found']:,} not in the ASN database, "
            f"{stats['failed']:,} lookup failures)."
        )
        logger.info(
            "asn_backfill_completed",
            rows_updated=updated.get("access_logs", 0),
            geo_rows_updated=updated.get("geo_events", 0),
            ips_resolved=stats["resolved"],
            ips_not_found=stats["not_found"],
            ips_lookup_failed=stats["failed"],
            cagg_refresh_failed=refresh_failed,
        )

        if refresh_failed:
            raise click.ClickException(
                f"Rows were stamped, but refreshing {', '.join(refresh_failed)} failed; "
                "the Top ASNs and Geo Logs views will not show the backfilled range "
                "until they refresh. Check the app log, then rerun this command (it is "
                "idempotent) or refresh those aggregates manually."
            )
    finally:
        reader.close()
        await engine.dispose()


@click.command(name="backfill-timings")
@click.option("--hostname", default=None, help="Only rows recorded by this LOGPARSER_HOST_NAME.")
@click.option(
    "--before",
    default=None,
    type=click.DateTime(formats=_DATETIME_FORMATS),
    help="Only rows older than this date or datetime (UTC when no offset is given).",
)
@click.option("--yes", is_flag=True, help="Skip the confirmation prompt.")
def backfill_timings_command(hostname: str | None, before: datetime | None, yes: bool) -> None:
    """Clear placeholder response times on rows that never carried one.

    Targets only rows the legacy nginx format wrote from a combined-style
    line: log_format 'nginx', no host, request_time 0. The custom nginx
    format always logs $host, so a host-less row had no timing field and
    its 0.0 was a placeholder, not a measurement. Rows written by the
    geometrikks-json format already store NULL. No blanket rewrite of
    zeros is offered: 0.000 is a real sub-millisecond timing.

    Prints the row count and time span first and asks for confirmation.
    Compressed hypertable chunks are decompressed before the update (a
    full-table UPDATE would trip the TimescaleDB tuple decompression
    limit); the compression policy recompresses them later. Refreshes the
    summary and URL continuous aggregates for the affected span. May run
    for minutes on large databases.
    """
    if before is not None and before.tzinfo is None:
        before = before.replace(tzinfo=timezone.utc)
    asyncio.run(_run_backfill_timings(hostname=hostname, before=before, yes=yes))


BACKFILL_TIMINGS_CAGGS = [
    "summary_hourly_stats",
    "summary_daily_stats",
    "url_hourly_stats",
    "url_daily_stats",
]


async def _run_backfill_timings(*, hostname: str | None, before: datetime | None, yes: bool) -> None:
    from sqlalchemy import text

    from geometrikks.server.logging import get_logger
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range

    logger = get_logger(__name__)
    config = get_sqlalchemy_config()
    engine = config.get_engine()

    where = "log_format = 'nginx' AND host IS NULL AND request_time = 0"
    params: dict[str, object] = {}
    if hostname is not None:
        where += " AND server = :hostname"
        params["hostname"] = hostname
    if before is not None:
        where += " AND timestamp < :before"
        params["before"] = before

    try:
        async with engine.connect() as conn:
            count, first, last = (await conn.execute(
                text(f"SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM access_logs WHERE {where}"),
                params,
            )).one()
            timescale = bool((await conn.execute(text(
                "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
            ))).scalar())

        if not count:
            click.echo("Nothing to do: no placeholder timings match.")
            return

        click.echo(f"{count:,} rows between {first} and {last} will have request_time set to NULL.")
        if not yes and not click.confirm("Continue?"):
            click.echo("Aborted.")
            return

        # Same reasoning as backfill-hostname: a full-table UPDATE on compressed
        # chunks trips timescaledb.max_tuples_decompressed_per_dml_transaction.
        if timescale:
            click.echo("Decompressing compressed access_logs chunks ...")
            async with engine.begin() as conn:
                await conn.execute(text(
                    "SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true) "
                    "FROM timescaledb_information.chunks "
                    "WHERE hypertable_name = 'access_logs' AND is_compressed"
                ))

        async with engine.begin() as conn:
            cleared = (await conn.execute(
                text(f"UPDATE access_logs SET request_time = NULL WHERE {where}"), params
            )).rowcount
        click.echo(f"access_logs placeholder timings cleared: {cleared:,}")

        failed: list[str] = []
        if cleared and first is not None and last is not None:
            click.echo("Refreshing summary and URL CAGGs ...")
            failed = await refresh_caggs_range(
                engine,
                start=first,
                end=last + timedelta(microseconds=1),
                caggs=BACKFILL_TIMINGS_CAGGS,
                force=True,
            )

        logger.info(
            "backfill_timings_completed",
            cleared=cleared,
            hostname=hostname,
            before=before.isoformat() if before else None,
            cagg_refresh_failed=failed,
        )

        if failed:
            raise click.ClickException(
                "Rows were cleared but these aggregates did not refresh: " + ", ".join(failed)
            )
    finally:
        await engine.dispose()


GEO_HOSTNAME_BACKFILL_BATCH_DAYS = 1


@click.command(name="backfill-geo-hostnames")
@click.option("--yes", is_flag=True, help="Skip the confirmation prompt.")
def backfill_geo_hostnames_command(yes: bool) -> None:
    """Fill historical hostname sets in the Geo Logs aggregates.

    Run after starting the updated app. Refreshes hourly and daily aggregates
    from retained geo_events, without rewriting source hostnames. Prints the
    pending ranges and asks for confirmation. May run for minutes on large
    databases; the app can stay running. Rerun after interruption to resume
    unfinished batches. History whose raw events expired cannot be recovered.
    """
    asyncio.run(_run_backfill_geo_hostnames(yes=yes))


async def _run_backfill_geo_hostnames(*, yes: bool) -> None:
    from sqlalchemy import text

    from geometrikks.config.settings import get_settings
    from geometrikks.server.hostname_backfill import hostname_backfill_ranges, pending_hostname_range
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range

    engine = get_sqlalchemy_config().get_engine()
    analytics = get_settings().analytics
    try:
        # Keep a dedicated session for the advisory lock while refresh CALLs
        # use their own connections outside transactions.
        async with engine.connect() as lock_conn:
            locked = (await lock_conn.execute(text(
                "SELECT pg_try_advisory_lock(714023, 1)"
            ))).scalar_one()
            if not locked:
                raise click.ClickException("Another Geo Logs hostname backfill is already running.")
            try:
                await lock_conn.commit()
                ranges = await hostname_backfill_ranges(
                    lock_conn, now=datetime.now(timezone.utc),
                    raw_retention_days=analytics.raw_retention_days,
                    hourly_retention_days=analytics.hourly_retention_days,
                )
                await lock_conn.commit()
                if not ranges:
                    click.echo("Nothing to do: no complete retained hostname buckets need backfilling.")
                    return
                for item in ranges:
                    click.echo(f"{item.view}: {item.start.isoformat()} to {item.end.isoformat()}")
                click.echo("Only complete retained buckets are refreshed. Expired raw history cannot be recovered.")
                if not yes and not click.confirm("Backfill these hostname aggregates?"):
                    click.echo("Aborted.")
                    return
                for item in ranges:
                    start = item.start
                    while start < item.end:
                        end = min(
                            start + timedelta(days=GEO_HOSTNAME_BACKFILL_BATCH_DAYS),
                            item.end,
                        )
                        async with engine.connect() as conn:
                            pending = await pending_hostname_range(conn, item.view, start, end)
                        if pending is not None:
                            click.echo(f"Refreshing {item.view}: {pending.start.isoformat()} to {pending.end.isoformat()} ...")
                            failed = await refresh_caggs_range(
                                engine, start=pending.start, end=pending.end, caggs=[item.view], force=True,
                            )
                            if failed:
                                raise click.ClickException(
                                    f"Refresh failed for {item.view}. Rerun this command to resume."
                                )
                        start = end
                click.echo("Geo Logs hostname backfill complete.")
            finally:
                await lock_conn.rollback()
                await lock_conn.execute(text("SELECT pg_advisory_unlock(714023, 1)"))
                await lock_conn.commit()
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    finally:
        await engine.dispose()


class ImportLogsCLIPlugin(CLIPlugin):
    """Register log import and backfill commands on the Litestar CLI group."""

    def on_cli_init(self, cli: click.Group) -> None:
        cli.add_command(import_logs_command)
        cli.add_command(import_loki_command)
        cli.add_command(backfill_hostname_command)
        cli.add_command(backfill_asn_command)
        cli.add_command(backfill_timings_command)
        cli.add_command(backfill_geo_hostnames_command)
