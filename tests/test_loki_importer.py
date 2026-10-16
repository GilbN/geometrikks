"""import_loki_range: windows, dedup, bookkeeping, format lock."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx2
import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logsources.loki import NS, LokiSource
from tests.test_loki_source import FakeLoki

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"
QUERY = '{job="nginx"}'
SINCE = datetime(2026, 9, 1, tzinfo=timezone.utc)


def make_log_line(ip: str, moment: datetime) -> str:
    stamp = moment.strftime("%d/%b/%Y:%H:%M:%S %z")
    return (
        f'{ip} - - [{stamp}]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


@pytest.fixture
def geoip_reader():
    with Reader(GEOIP_DB_PATH) as reader:
        yield reader


@pytest.fixture
def fake() -> FakeLoki:
    return FakeLoki()


def make_source(fake: FakeLoki, **kwargs) -> LokiSource:
    kwargs.setdefault("url", "http://loki:3100")
    kwargs.setdefault("query", QUERY)
    kwargs.setdefault("label", "loki:1")
    kwargs.setdefault("hostname", "edge-01")
    return LokiSource(transport=httpx2.MockTransport(fake.respond), **kwargs)


def add_line(fake: FakeLoki, moment: datetime, ip: str = TEST_IP, offset_ns: int = 0) -> None:
    fake.add_ns(int(moment.timestamp()) * NS + offset_ns, make_log_line(ip, moment))


def to_ns_of(moment: datetime) -> int:
    return int(moment.timestamp()) * NS


class FakeLokiImportRepo:
    """In-memory loki_imports keyed by id. Shared across sessions via the class."""

    rows: list[Any] = []

    def __init__(self, session) -> None: ...

    @classmethod
    def reset(cls) -> None:
        cls.rows = []

    @classmethod
    def _identity_matches(cls, row, url, tenant_id, query) -> bool:
        return row.url == url and row.tenant_id == tenant_id and row.query == query

    async def find_resumable(self, *, url, tenant_id, query, since, before):
        for row in reversed(self.rows):
            if (
                self._identity_matches(row, url, tenant_id, query)
                and row.range_start == since
                and row.range_end == before
                and row.cursor < row.range_end
            ):
                return row
        return None

    async def find_overlapping(self, *, url, tenant_id, query, since, before):
        for row in sorted(self.rows, key=lambda row: row.range_start):
            if (
                self._identity_matches(row, url, tenant_id, query)
                and row.range_start < before
                and row.cursor > since
                and row.cursor > row.range_start
            ):
                return row
        return None

    async def add(self, loki_import, auto_commit=True):
        loki_import.id = len(self.rows) + 1
        self.rows.append(loki_import)
        return loki_import

    async def get(self, item_id):
        return next(row for row in self.rows if row.id == item_id)

    async def update(self, loki_import, auto_commit=True):
        return loki_import


@pytest.fixture
def deps(monkeypatch):
    from geometrikks.services import loki_importer

    FakeLokiImportRepo.reset()
    monkeypatch.setattr(loki_importer, "LokiImportRepository", FakeLokiImportRepo)
    service = MagicMock()
    service.flush_records = AsyncMock()
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)
    return service, (lambda: session)


def flushed_records(service) -> list:
    return [record for call in service.flush_records.await_args_list for record in call.args[0]]


def test_to_ns_keeps_microseconds() -> None:
    from geometrikks.services.loki_importer import to_ns

    moment = datetime(2026, 9, 1, 12, 0, 0, 123456, tzinfo=timezone.utc)
    assert to_ns(moment) == int(moment.timestamp()) * NS + 123_456_000


async def test_walks_the_range_in_hour_windows(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    for hour in range(3):
        add_line(fake, SINCE + timedelta(hours=hour, minutes=30))
    source = make_source(fake)

    result = await import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=3),
    )

    assert result.records_written == 3
    assert result.lines_total == 3
    starts = [int(request.url.params["start"]) for request in fake.requests]
    ends = [int(request.url.params["end"]) for request in fake.requests]
    assert starts == [int((SINCE + timedelta(hours=h)).timestamp()) * NS for h in range(3)]
    assert ends == [int((SINCE + timedelta(hours=h + 1)).timestamp()) * NS for h in range(3)]
    [row] = FakeLokiImportRepo.rows
    assert row.cursor == SINCE + timedelta(hours=3)
    assert row.records_written == 3
    assert row.hostname == "edge-01"
    assert all(record.hostname == "edge-01" for record in flushed_records(service))


async def test_page_boundary_entries_are_written_once(fake, geoip_reader, deps, monkeypatch) -> None:
    """A full page ends at timestamp T; the next page starts at T inclusive."""
    from geometrikks.services import loki_importer
    from geometrikks.services.logsources import loki as loki_module

    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 3)
    service, session_maker = deps
    moment = SINCE + timedelta(minutes=5)
    for offset in range(5):
        # entries 2, 3 and 4 share the second but not the nanosecond
        add_line(fake, moment if offset >= 2 else moment - timedelta(seconds=1), offset_ns=offset)
    source = make_source(fake)

    result = await loki_importer.import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=1),
    )

    assert result.lines_total == 5
    assert result.records_written == 5
    assert len(fake.requests) >= 2


async def test_entry_at_window_boundary_is_written_once(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    boundary = SINCE + timedelta(hours=1)
    add_line(fake, boundary)
    source = make_source(fake)

    result = await import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=2),
    )

    assert result.lines_total == 1
    assert result.records_written == 1


async def test_format_locks_on_first_non_empty_page(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    add_line(fake, SINCE + timedelta(hours=2, minutes=1))
    source = make_source(fake)

    result = await import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=3),
    )

    assert result.records_written == 1


async def test_unrecognized_format_aborts_before_writing(fake, geoip_reader, deps) -> None:
    from geometrikks.services.importer import UnrecognizedLogFormatError
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    fake.add_ns(to_ns_of(SINCE + timedelta(minutes=1)), "this is not an access log line")
    source = make_source(fake)

    with pytest.raises(UnrecognizedLogFormatError):
        await import_loki_range(
            source, service=service, parser=LogParser(source_label="loki", send_logs=True),
            reader=geoip_reader, session_maker=session_maker,
            since=SINCE, before=SINCE + timedelta(hours=1),
        )
    assert service.flush_records.await_count == 0


async def test_empty_range_completes_with_zero_counts(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    source = make_source(fake)

    result = await import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=2),
    )

    assert result.lines_total == 0
    assert result.records_written == 0
    assert service.flush_records.await_count == 0
    [row] = FakeLokiImportRepo.rows
    assert row.cursor == SINCE + timedelta(hours=2)


async def test_ignored_ip_and_unmatched_line_count_as_skipped(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    moment = SINCE + timedelta(minutes=1)
    add_line(fake, moment)
    add_line(fake, moment, ip="10.0.0.9", offset_ns=1)
    fake.add_ns(to_ns_of(moment) + 2, "garbage that matches nothing")
    source = make_source(fake)

    result = await import_loki_range(
        source, service=service,
        parser=LogParser(source_label="loki", send_logs=True, ignore_ips=["10.0.0.9"]),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(hours=1),
    )

    assert result.lines_total == 3
    assert result.lines_skipped == 2
    assert result.records_written == 1


async def test_transport_error_leaves_cursor_at_last_window_and_resume_continues(
    fake, geoip_reader, deps
) -> None:
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    for hour in range(3):
        add_line(fake, SINCE + timedelta(hours=hour, minutes=30))
    source = make_source(fake)
    parser = LogParser(source_label="loki", send_logs=True)
    before = SINCE + timedelta(hours=3)

    failed_once: list[bool] = []

    def fail_second_window(request: httpx2.Request) -> httpx2.Response:
        if int(request.url.params["start"]) == to_ns_of(SINCE + timedelta(hours=1)) and not failed_once:
            failed_once.append(True)
            raise httpx2.ConnectError("connection refused", request=request)
        return fake.respond(request)

    source = LokiSource(
        url="http://loki:3100", query=QUERY, label="loki:1", hostname="edge-01",
        transport=httpx2.MockTransport(fail_second_window),
    )

    with pytest.raises(httpx2.HTTPError):
        await import_loki_range(
            source, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker, since=SINCE, before=before,
        )
    [row] = FakeLokiImportRepo.rows
    assert row.cursor == SINCE + timedelta(hours=1)
    assert row.records_written == 1

    result = await import_loki_range(
        source, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker, since=SINCE, before=before,
    )

    assert result.resumed_from == SINCE + timedelta(hours=1)
    assert result.records_written == 2
    assert row.cursor == before
    assert row.records_written == 3
    assert len(FakeLokiImportRepo.rows) == 1


async def test_completed_range_is_refused(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import LokiImportOverlapError, import_loki_range

    service, session_maker = deps
    source = make_source(fake)
    parser = LogParser(source_label="loki", send_logs=True)
    before = SINCE + timedelta(hours=1)
    await import_loki_range(
        source, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker, since=SINCE, before=before,
    )

    with pytest.raises(LokiImportOverlapError, match="already imported"):
        await import_loki_range(
            source, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker, since=SINCE, before=before,
        )


async def test_partial_overlap_is_refused_and_force_writes_a_new_row(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import LokiImportOverlapError, import_loki_range

    service, session_maker = deps
    source = make_source(fake)
    parser = LogParser(source_label="loki", send_logs=True)
    await import_loki_range(
        source, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker, since=SINCE, before=SINCE + timedelta(hours=2),
    )

    with pytest.raises(LokiImportOverlapError):
        await import_loki_range(
            source, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker,
            since=SINCE + timedelta(hours=1), before=SINCE + timedelta(hours=3),
        )

    await import_loki_range(
        source, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
        since=SINCE + timedelta(hours=1), before=SINCE + timedelta(hours=3), force=True,
    )
    assert len(FakeLokiImportRepo.rows) == 2


async def test_abandoned_tail_does_not_count_as_imported(fake, geoip_reader, deps) -> None:
    """[cursor, range_end) of an unfinished run is free for a different range."""
    from geometrikks.services.loki_importer import import_loki_range

    service, session_maker = deps
    source = make_source(fake)
    parser = LogParser(source_label="loki", send_logs=True)
    row = MagicMock(
        id=1, url=source.url, tenant_id=None, query=QUERY, hostname="edge-01",
        range_start=SINCE, range_end=SINCE + timedelta(hours=4), cursor=SINCE + timedelta(hours=1),
        lines_total=0, lines_skipped=0, records_written=0, time_start=None, time_end=None,
    )
    FakeLokiImportRepo.rows.append(row)

    await import_loki_range(
        source, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
        since=SINCE + timedelta(hours=2), before=SINCE + timedelta(hours=3),
    )
    assert len(FakeLokiImportRepo.rows) == 2


async def test_progress_reports_once_per_day(fake, geoip_reader, deps) -> None:
    from geometrikks.services.loki_importer import LokiImportProgress, import_loki_range

    service, session_maker = deps
    source = make_source(fake)
    reports: list[LokiImportProgress] = []

    await import_loki_range(
        source, service=service, parser=LogParser(source_label="loki", send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        since=SINCE, before=SINCE + timedelta(days=2, hours=1), progress=reports.append,
    )

    assert [report.day for report in reports] == [
        SINCE.date(), (SINCE + timedelta(days=1)).date(), (SINCE + timedelta(days=2)).date()
    ]
