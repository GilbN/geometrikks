"""Backfill a time range of one Loki selector through the live pipeline.

The Loki counterpart of importer.py. The unit of bookkeeping is a time
range of one selector, not a file checksum. The range is walked in
one-hour windows; after each window's rows commit, the loki_imports row's
cursor moves to the window's end, so a rerun of the same range resumes
there. A crash between the commit and the cursor update re-imports that
hour on resume. Batches already flushed from a window that then fails are
written again.

CLI-only, like importer.py: free of click so an endpoint could reuse it.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING

from geometrikks.domain.imports.models import LokiImport
from geometrikks.domain.imports.repositories import LokiImportRepository
from geometrikks.server.logging import get_logger
from geometrikks.services.importer import UnrecognizedLogFormatError
from geometrikks.services.logparser.logparser import (
    make_cached_asn_lookup,
    make_cached_city_lookup,
)
from geometrikks.services.logparser.schemas import ParsedLogRecord
from geometrikks.services.logsources.loki import NS, Entry

if TYPE_CHECKING:
    from geoip2.database import Reader
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.services.ingestion.service import LogIngestionService
    from geometrikks.services.logparser.logparser import LogParser
    from geometrikks.services.logsources.loki import LokiSource

logger = get_logger(__name__)

WINDOW_SECONDS = 3600


class LokiImportOverlapError(ValueError):
    """The range overlaps one already imported for this selector."""


class LokiImportWriteError(RuntimeError):
    """A batch failed to commit; the window is not recorded as imported."""


@dataclass
class LokiImportProgress:
    day: date
    lines_total: int
    records_written: int
    lines_per_second: float


@dataclass
class LokiImportResult:
    """time_start/time_end span every row the range's runs wrote, so a refresh after a
    resume covers the first run's rows.
    """

    lines_total: int
    lines_skipped: int
    records_written: int
    time_start: datetime | None
    time_end: datetime | None
    duration_seconds: float
    resumed_from: datetime | None


def to_ns(moment: datetime) -> int:
    # timestamp() is a float; multiplying it by 1e9 rounds away microseconds.
    return int(moment.timestamp()) * NS + moment.microsecond * 1000


def _earliest(first: datetime | None, second: datetime | None) -> datetime | None:
    return min(first, second) if first and second else first or second


def _latest(first: datetime | None, second: datetime | None) -> datetime | None:
    return max(first, second) if first and second else first or second


@dataclass
class _Counters:
    lines_total: int = 0
    lines_skipped: int = 0
    records_written: int = 0
    time_start: datetime | None = None
    time_end: datetime | None = None

    def note(self, record: ParsedLogRecord) -> None:
        if record.timestamp is not None:
            self.time_start = _earliest(self.time_start, record.timestamp)
            self.time_end = _latest(self.time_end, record.timestamp)


def _overlap_error(source: LokiSource, overlap: LokiImport) -> LokiImportOverlapError:
    return LokiImportOverlapError(
        f"{source.query}: {overlap.range_start.isoformat()} to "
        f"{overlap.cursor.isoformat()} is already imported for this selector "
        f"(row {overlap.id}). --force skips this check and imports the range again, "
        "duplicating the rows already written."
    )


async def _flush(service: LogIngestionService, batch: list[ParsedLogRecord]) -> int:
    """Flush one batch and return the records written.

    Raises:
        LokiImportWriteError: the service logged a failed batch. flush_records
            swallows commit failures, and a lost batch must not advance the cursor.
    """
    failed_before = service.failed_records
    await service.flush_records(batch)
    lost = service.failed_records - failed_before
    if lost:
        raise LokiImportWriteError(
            f"{lost} record(s) failed to commit; see ingestion_batch_failed in the log"
        )
    return sum(1 for record in batch if record.ip_address is not None)


async def _claim_row(
    source: LokiSource,
    session_maker: Callable[[], AsyncSession],
    since: datetime,
    before: datetime,
    force: bool,
) -> tuple[int, datetime, _Counters, datetime | None]:
    """The row this run writes to: resumed, refused, or new.

    Returns the row id, the cursor to start from, the counts stored so far
    (folded into the row as the run adds to them) and the resume point.
    """
    identity = {"url": source.url, "tenant_id": source.tenant_id, "query": source.query}
    async with session_maker() as session:
        repo = LokiImportRepository(session=session)
        loki_import = await repo.find_resumable(since=since, before=before, **identity)
        if not force:
            check_from = since if loki_import is None else loki_import.cursor
            overlap = await repo.find_overlapping(since=check_from, before=before, **identity)
            if overlap is not None:
                raise _overlap_error(source, overlap)
        if loki_import is not None:
            stored = _Counters(
                lines_total=loki_import.lines_total,
                lines_skipped=loki_import.lines_skipped,
                records_written=loki_import.records_written,
                time_start=loki_import.time_start,
                time_end=loki_import.time_end,
            )
            return loki_import.id, loki_import.cursor, stored, loki_import.cursor
        loki_import = await repo.add(
            LokiImport(
                hostname=source.hostname,
                range_start=since,
                range_end=before,
                cursor=since,
                **identity,
            ),
            auto_commit=True,
        )
        return loki_import.id, since, _Counters(), None


async def claim_loki_range(
    source: LokiSource,
    *,
    session_maker: Callable[[], AsyncSession],
    since: datetime,
    before: datetime,
    force: bool = False,
) -> None:
    """Record the range this selector will import, so an interrupted run leaves every
    selector's bounds behind. import_loki_range finds the row and resumes it from ``since``.
    """
    await _claim_row(source, session_maker, since, before, force)


async def _advance_row(
    session_maker: Callable[[], AsyncSession],
    row_id: int,
    cursor: datetime,
    stored: _Counters,
    run: _Counters,
) -> None:
    async with session_maker() as session:
        repo = LokiImportRepository(session=session)
        loki_import = await repo.get(row_id)
        loki_import.cursor = cursor
        loki_import.lines_total = stored.lines_total + run.lines_total
        loki_import.lines_skipped = stored.lines_skipped + run.lines_skipped
        loki_import.records_written = stored.records_written + run.records_written
        loki_import.time_start = _earliest(stored.time_start, run.time_start)
        loki_import.time_end = _latest(stored.time_end, run.time_end)
        await repo.update(loki_import, auto_commit=True)


async def import_loki_range(
    source: LokiSource,
    *,
    service: LogIngestionService,
    parser: LogParser,
    reader: Reader,
    asn_reader: Reader | None = None,
    session_maker: Callable[[], AsyncSession],
    since: datetime,
    before: datetime,
    batch_size: int = 500,
    force: bool = False,
    progress: Callable[[LokiImportProgress], None] | None = None,
) -> LokiImportResult:
    """Import [since, before) of one selector. See module docstring.

    Bounds are Loki entry timestamps. The format is locked from the first
    non-empty page, so the check samples the data being imported. ``force``
    skips the overlap checks; an unfinished run of exactly this range still
    resumes.

    Raises:
        LokiImportOverlapError: part of the range is already imported.
        UnrecognizedLogFormatError: the first page matches no log format.
        LokiImportWriteError: A batch failed to commit; the window is not
            recorded as imported. Records the service committed from that
            batch before the failure are written again on resume.
        httpx2.HTTPError, LokiRejected: Loki failed mid-range; the row
            stays at the last completed window and a rerun resumes there.
            Batches already flushed from the failed window are written again.
    """
    started = time.monotonic()
    row_id, cursor, stored, _ = await _claim_row(
        source, session_maker, since, before, force
    )
    resumed_from = cursor if cursor > since else None

    lookup = make_cached_city_lookup(reader)
    asn_lookup = make_cached_asn_lookup(asn_reader) if asn_reader is not None else None
    run = _Counters()
    format_locked = False
    window = timedelta(seconds=WINDOW_SECONDS)

    while cursor < before:
        window_start = cursor
        window_end = min(cursor + window, before)
        batch: list[ParsedLogRecord] = []
        # Each page after the first starts at the previous page's last
        # timestamp, inclusive, so the entries at that timestamp come back.
        carried: set[Entry] = set()
        async with contextlib.aclosing(
            source.read_range(to_ns(window_start), to_ns(window_end))
        ) as pages:
            async for page in pages:
                if not page:
                    continue
                if not format_locked:
                    if not parser.lock_format_from([line for _, _, line in page]):
                        raise UnrecognizedLogFormatError(
                            f"{source.query}: none of the first {len(page)} lines from "
                            f"{window_start.isoformat()} match the expected log format"
                        )
                    format_locked = True
                for loki_entry in page:
                    if loki_entry in carried:
                        continue
                    run.lines_total += 1
                    record = parser.parse_line(loki_entry[2], lookup, asn_lookup)
                    if record is None:  # IP on the ignore list
                        run.lines_skipped += 1
                        continue
                    if record.ip_address is None:  # line didn't match the format
                        run.lines_skipped += 1
                    record.hostname = source.hostname
                    run.note(record)
                    batch.append(record)
                    if len(batch) >= batch_size:
                        run.records_written += await _flush(service, batch)
                        batch = []
                last_timestamp = page[-1][0]
                carried = {loki_entry for loki_entry in page if loki_entry[0] == last_timestamp}
        if batch:
            run.records_written += await _flush(service, batch)
        cursor = window_end
        await _advance_row(session_maker, row_id, cursor, stored, run)
        if progress and (window_end.date() != window_start.date() or cursor >= before):
            elapsed = time.monotonic() - started
            progress(
                LokiImportProgress(
                    day=window_start.date(),
                    lines_total=run.lines_total,
                    records_written=run.records_written,
                    lines_per_second=run.lines_total / elapsed if elapsed else 0.0,
                )
            )

    logger.success(  # ty: ignore[unresolved-attribute]
        "loki_import_completed",
        query=source.query,
        hostname=source.hostname,
        since=since.isoformat(),
        before=before.isoformat(),
        lines=run.lines_total,
        records=run.records_written,
        resumed_from=resumed_from.isoformat() if resumed_from else None,
    )
    return LokiImportResult(
        lines_total=run.lines_total,
        lines_skipped=run.lines_skipped,
        records_written=run.records_written,
        time_start=_earliest(stored.time_start, run.time_start),
        time_end=_latest(stored.time_end, run.time_end),
        duration_seconds=time.monotonic() - started,
        resumed_from=resumed_from,
    )
