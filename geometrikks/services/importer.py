"""Batch import of historical access-log files.

Reuses the live pipeline: LogParser.parse_line for parsing and
LogIngestionService.flush_records for persistence (same location cache and
rollback semantics). Duplicate protection via sha256 in import_jobs.
Documented limitation: a file that was also live-tailed double-counts.

CLI-only for now. Deliberately free of click/CLI concerns so a future authed
import endpoint can reuse import_file() — but note for that future work:
sha256_file and iter_lines are synchronous file IO (fine in a dedicated CLI
process, event-loop-blocking in a server) and must be wrapped in
asyncio.to_thread there; batches commit incrementally, so a crashed import
leaves committed rows with no import_jobs row (a re-run then double-counts) —
an endpoint wants a status column and/or cleanup story for that.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from geometrikks.domain.imports.models import ImportJob
from geometrikks.domain.imports.repositories import ImportJobRepository
from geometrikks.services.logparser.logparser import make_cached_city_lookup
from geometrikks.services.logparser.schemas import ParsedLogRecord

if TYPE_CHECKING:
    from geoip2.database import Reader
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.services.ingestion.service import LogIngestionService
    from geometrikks.services.logparser.logparser import LogParser

logger = logging.getLogger(__name__)

PROGRESS_EVERY_LINES = 10_000
FORMAT_CHECK_LINES = 1_000


class UnrecognizedLogFormatError(ValueError):
    """No line in the sampled prefix matched the expected log format."""


@dataclass
class ImportResult:
    file_path: Path
    skipped: bool
    lines_total: int
    lines_skipped: int
    records_written: int
    time_start: datetime | None
    time_end: datetime | None
    duration_seconds: float


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def iter_lines(path: Path) -> Iterator[str]:
    """Yield text lines; transparent gzip for *.gz; binary junk survives."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        yield from f


def _format_sanity_check(path: Path, parser: LogParser, sample: int = FORMAT_CHECK_LINES) -> None:
    """Abort before writing anything if no sampled line matches the log format.

    Every unmatched line becomes a malformed record, and _flush_batch writes a
    debug row per malformed record regardless of store_debug_lines — a
    wrong-format file would flood access_log_debug otherwise. Empty files pass.
    """
    checked = 0
    for line in iter_lines(path):
        if parser.validate_log_line(line):
            return
        checked += 1
        if checked >= sample:
            break
    if checked:
        raise UnrecognizedLogFormatError(
            f"{path}: none of the first {checked} lines match the expected log format"
        )


def _record_timestamp(record: ParsedLogRecord) -> datetime | None:
    if record.access_log:
        return record.access_log.timestamp
    if record.geo_data:
        return record.geo_data.timestamp
    return None


async def import_file(
    path: Path,
    *,
    service: "LogIngestionService",
    parser: "LogParser",
    reader: "Reader",
    session_maker: "Callable[[], AsyncSession]",
    batch_size: int = 500,
    force: bool = False,
    progress: Callable[[int, float], None] | None = None,
) -> ImportResult:
    """Import one whole file through the live pipeline. See module docstring."""
    started = time.monotonic()
    checksum = sha256_file(path)

    async with session_maker() as session:
        repo = ImportJobRepository(session=session)
        existing = await repo.get_by_checksum(checksum)
    if existing is not None and not force:
        logger.info("Skipping %s: checksum already imported", path)
        return ImportResult(
            file_path=path, skipped=True, lines_total=0, lines_skipped=0,
            records_written=0, time_start=None, time_end=None,
            duration_seconds=time.monotonic() - started,
        )

    _format_sanity_check(path, parser)

    lookup = make_cached_city_lookup(reader)
    batch: list[ParsedLogRecord] = []
    lines_total = 0
    lines_skipped = 0
    records_written = 0
    time_start: datetime | None = None
    time_end: datetime | None = None

    for line in iter_lines(path):
        lines_total += 1
        record = parser.parse_line(line, lookup)
        batch.append(record)

        if record.ip_address is None:  # line didn't match the format
            lines_skipped += 1

        if ts := _record_timestamp(record):
            time_start = ts if time_start is None or ts < time_start else time_start
            time_end = ts if time_end is None or ts > time_end else time_end

        if len(batch) >= batch_size:
            await service.flush_records(batch)
            records_written += sum(1 for r in batch if r.ip_address is not None)
            batch = []

        if progress and lines_total % PROGRESS_EVERY_LINES == 0:
            elapsed = time.monotonic() - started
            progress(lines_total, lines_total / elapsed if elapsed else 0.0)

    if batch:
        await service.flush_records(batch)
        records_written += sum(1 for r in batch if r.ip_address is not None)

    async with session_maker() as session:
        repo = ImportJobRepository(session=session)
        if existing is not None:
            # --force re-import: checksum is unique, so update the prior row.
            existing.file_path = str(path)
            existing.lines_total = lines_total
            existing.lines_skipped = lines_skipped
            existing.records_written = records_written
            existing.time_start = time_start
            existing.time_end = time_end
            await repo.update(existing, auto_commit=True)
        else:
            await repo.add(
                ImportJob(
                    file_path=str(path),
                    checksum=checksum,
                    lines_total=lines_total,
                    lines_skipped=lines_skipped,
                    records_written=records_written,
                    time_start=time_start,
                    time_end=time_end,
                ),
                auto_commit=True,
            )

    return ImportResult(
        file_path=path, skipped=False, lines_total=lines_total,
        lines_skipped=lines_skipped, records_written=records_written,
        time_start=time_start, time_end=time_end,
        duration_seconds=time.monotonic() - started,
    )
