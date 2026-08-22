"""Litestar CLI plugin: `litestar import-logs <paths...>`, `litestar backfill-hostname NAME`, `litestar backfill-asn`.

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
@click.option(
    "--hostname",
    default=None,
    help=(
        "Source hostname stamped on imported records. Default: the first "
        "LOGPARSER_HOST_NAME value."
    ),
)
def import_logs_command(
    paths: tuple[Path, ...], force: bool, batch_size: int, log_format: str, hostname: str | None
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
    asyncio.run(
        _run_import(
            list(paths), force=force, batch_size=batch_size, log_format=log_format, hostname=hostname
        )
    )


async def _run_import(
    paths: list[Path], *, force: bool, batch_size: int, log_format: str, hostname: str | None
) -> None:
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

    asn_reader: Reader | None = (
        create_reader(settings.geoip.asn_db_path) if settings.geoip.asn_enabled else None
    )
    if settings.geoip.asn_enabled and asn_reader is None:
        click.echo("No GeoLite2 ASN database found; importing without ASN enrichment.")

    effective_hostname = hostname or settings.logparser.resolved_hostnames()[0]
    click.echo(f"Stamping hostname: {effective_hostname}")
    service = LogIngestionService(
        parsers=[],
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        hostname=effective_hostname,
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
                    asn_reader=asn_reader,
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
        if asn_reader is not None:
            asn_reader.close()

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

        # Cheap EXISTS probes (hostname is indexed) so a rerun with nothing
        # left to change exits before the expensive decompression below.
        async with engine.connect() as conn:
            async def _exists(sql: str) -> bool:
                return bool((await conn.execute(text(sql), {"n": name})).scalar())

            needs_fill = await _exists(
                "SELECT EXISTS (SELECT 1 FROM access_logs WHERE hostname IS NULL)")
            needs_logs_rewrite = consolidate and await _exists(
                "SELECT EXISTS (SELECT 1 FROM access_logs "
                "WHERE hostname IS NOT NULL AND hostname <> :n)")
            needs_geo_rewrite = consolidate and await _exists(
                "SELECT EXISTS (SELECT 1 FROM geo_events WHERE hostname <> :n)")
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

        # The hostname CAGGs still show the old values until refreshed. The
        # plain fill path needs this too: without it log_source_daily_stats
        # keeps hostname NULL for history, and once raw retention drops the
        # access_logs rows the facet can never be corrected.
        # Ranges are computed per source table: hostname_daily_stats reads
        # geo_events while log_source_daily_stats reads access_logs, and
        # the two tables' time bounds differ (access logs exist for rows
        # that never produced a geo event).
        if filled or rewritten_geo or rewritten_logs:
            click.echo("Refreshing hostname CAGGs ...")
            async with engine.connect() as conn:
                for table, cagg in (
                    ("geo_events", "hostname_daily_stats"),
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


@click.command(name="backfill-asn")
@click.option("--yes", is_flag=True, help="Skip the confirmation prompt.")
def backfill_asn_command(yes: bool) -> None:
    """Stamp ASN data onto historical rows from the current ASN database.

    Fills only access_logs rows with NULL autonomous_system_number
    (idempotent, cannot overwrite stamped values) by resolving each
    distinct IP through the local GeoLite2-ASN database. IPs the database
    cannot resolve stay NULL. Refreshes the ASN continuous aggregates for
    the affected range when rows changed. Compressed hypertable chunks are
    decompressed first (a full-table UPDATE would trip the TimescaleDB
    tuple decompression limit); the compression policy recompresses them
    later. May run for minutes on large databases.
    """
    asyncio.run(_run_backfill_asn(yes=yes))


ASN_BACKFILL_CHUNK_SIZE = 10_000


async def _iter_null_asn_ips(engine, *, chunk_size: int = ASN_BACKFILL_CHUNK_SIZE):
    """Yield distinct NULL-ASN client IPs in keyset-paginated chunks.

    Keyset pagination on the inet column (OFFSET would rescan) holds one
    chunk in memory at a time; on an internet-facing install the distinct-IP
    count can approach the row count.
    """
    from sqlalchemy import text

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
                f"FROM access_logs WHERE {where} "
                f"ORDER BY ip_address LIMIT :lim"
            ), params)).all()
        if not rows:
            return
        yield [row.ip_text for row in rows]
        last = rows[-1].ip_text


async def _apply_asn_mapping(engine, chunks) -> int:
    """Stream ip -> (asn, org) chunks into a temp table, then one join UPDATE.

    One transaction, so the ON COMMIT DROP temp table spans every chunk
    while only the chunk in flight is held. Returns the UPDATE rowcount.
    ``chunks`` is a list of mapping dicts (one chunk) or an async iterable
    of them. Kept separate from _run_backfill_asn so the integration tests
    can run the SQL against a real database.
    """
    from sqlalchemy import text

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
            "UPDATE access_logs al "
            "SET autonomous_system_number = m.asn, "
            "    autonomous_system_organization = m.org "
            "FROM tmp_asn_map m "
            "WHERE al.autonomous_system_number IS NULL AND al.ip_address = m.ip"
        ))).rowcount


async def _run_backfill_asn(*, yes: bool) -> None:
    from sqlalchemy import text

    from geometrikks.config.settings import get_settings
    from geometrikks.server.logging import get_logger
    from geometrikks.server.plugins import get_sqlalchemy_config
    from geometrikks.server.timescale import refresh_caggs_range
    from geometrikks.services.ingestion.service import create_reader

    logger = get_logger(__name__)
    settings = get_settings()
    reader = create_reader(settings.geoip.asn_db_path)
    if reader is None:
        raise click.ClickException(
            f"No GeoLite2 ASN database at {settings.geoip.asn_db_path}. Start "
            "the app once with MaxMind credentials to download it, or place "
            "the mmdb there yourself."
        )

    config = get_sqlalchemy_config()
    engine = config.get_engine()
    try:
        # Cheap EXISTS probe (the ASN column is indexed) so a rerun with
        # nothing left to fill exits before the expensive scans below.
        async with engine.connect() as conn:
            needs_fill = bool((await conn.execute(text(
                "SELECT EXISTS (SELECT 1 FROM access_logs "
                "WHERE autonomous_system_number IS NULL)"
            ))).scalar())
            timescale = bool((await conn.execute(text(
                "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
            ))).scalar())

        if not needs_fill:
            click.echo("Nothing to do: no rows without ASN data.")
            return

        click.echo("Scanning rows without ASN data ...")
        async with engine.connect() as conn:
            null_rows, distinct_ips = (await conn.execute(text(
                "SELECT COUNT(*), COUNT(DISTINCT ip_address) FROM access_logs "
                "WHERE autonomous_system_number IS NULL"
            ))).one()

        click.echo(f"{null_rows:,} rows across {distinct_ips:,} distinct IPs lack ASN data.")
        if not yes and not click.confirm("Backfill them from the local ASN database?"):
            click.echo("Aborted.")
            return

        # Bounds before the update: after it, the NULL set shrinks and the
        # refresh range for the changed rows would be lost.
        async with engine.connect() as conn:
            bounds = (await conn.execute(text(
                "SELECT MIN(timestamp), MAX(timestamp) FROM access_logs "
                "WHERE autonomous_system_number IS NULL"
            ))).one()

        # Decompression precedes the write: the UPDATE inside
        # _apply_asn_mapping would otherwise trip
        # timescaledb.max_tuples_decompressed_per_dml_transaction. Same
        # pattern as backfill-hostname; the compression policy recompresses
        # on its own schedule.
        if timescale:
            click.echo("Decompressing compressed access_logs chunks ...")
            async with engine.begin() as conn:
                await conn.execute(text(
                    "SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true) "
                    "FROM timescaledb_information.chunks "
                    "WHERE hypertable_name = 'access_logs' AND is_compressed"
                ))

        from geoip2.errors import AddressNotFoundError

        stats = {"resolved": 0, "not_found": 0, "failed": 0}

        async def _resolved_chunks():
            """Resolve each IP chunk as it arrives; only one is ever held."""
            async for ips in _iter_null_asn_ips(engine):
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

        click.echo("Resolving IPs against the ASN database ...")
        updated = await _apply_asn_mapping(engine, _resolved_chunks())
        click.echo(
            f"Resolved {stats['resolved']:,} IPs "
            f"({stats['not_found']:,} not in the ASN database, "
            f"{stats['failed']:,} lookup failures)."
        )
        click.echo(f"access_logs rows updated: {updated:,}")

        # The ASN CAGGs exclude NULL-ASN rows, so backfilled history stays
        # invisible to /top-asns until the range is refreshed. A failed
        # refresh must fail the run: ranges outside the policy window are
        # never retried automatically.
        refresh_failed: list[str] = []
        if updated and bounds[0] is not None:
            click.echo("Refreshing ASN CAGGs ...")
            refresh_failed = await refresh_caggs_range(
                engine,
                start=bounds[0],
                end=bounds[1] + timedelta(microseconds=1),
                caggs=["asn_hourly_stats", "asn_daily_stats"],
            )

        logger.info(
            "asn_backfill_completed",
            rows_updated=updated,
            ips_resolved=stats["resolved"],
            ips_not_found=stats["not_found"],
            ips_lookup_failed=stats["failed"],
            cagg_refresh_failed=refresh_failed,
        )

        if refresh_failed:
            raise click.ClickException(
                f"Rows were stamped, but refreshing {', '.join(refresh_failed)} failed; "
                "the Top ASNs view will not show the backfilled range until they "
                "refresh. Check the app log, then rerun this command (it is "
                "idempotent) or refresh those aggregates manually."
            )
    finally:
        reader.close()
        await engine.dispose()


class ImportLogsCLIPlugin(CLIPlugin):
    """Registers import-logs, backfill-hostname, and backfill-asn on the litestar CLI group."""

    def on_cli_init(self, cli: click.Group) -> None:
        cli.add_command(import_logs_command)
        cli.add_command(backfill_hostname_command)
        cli.add_command(backfill_asn_command)
