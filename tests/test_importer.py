"""Batch importer: checksum skip, gzip transparency, batching, time bounds."""
from __future__ import annotations

import gzip
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.logparser import LogParser

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"


def make_log_line(ip: str, day: int = 3) -> str:
    return (
        f'{ip} - - [{day:02d}/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


@pytest.fixture
def geoip_reader():
    with Reader(GEOIP_DB_PATH) as reader:
        yield reader


def test_sha256_file(tmp_path):
    from geometrikks.services.importer import sha256_file
    p = tmp_path / "a.log"
    p.write_bytes(b"hello\n")
    assert sha256_file(p) == hashlib.sha256(b"hello\n").hexdigest()


def test_iter_lines_plain_and_gz(tmp_path):
    from geometrikks.services.importer import iter_lines
    plain = tmp_path / "a.log"
    plain.write_text("one\ntwo\n")
    gz = tmp_path / "a.log.gz"
    with gzip.open(gz, "wt") as f:
        f.write("three\nfour\n")
    assert [l.strip() for l in iter_lines(plain)] == ["one", "two"]
    assert [l.strip() for l in iter_lines(gz)] == ["three", "four"]


def _import_deps(tmp_path):
    """Fake service + repo wiring for import_file unit tests."""
    service = MagicMock()
    service.flush_records = AsyncMock()

    existing_job = None

    class FakeRepo:
        def __init__(self, session): ...
        async def get_by_checksum(self, checksum):
            return existing_job
        async def add(self, job, auto_commit=True):
            return job
        async def update(self, job, auto_commit=True):
            return job

    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)
    session.commit = AsyncMock()

    return service, FakeRepo, (lambda: session)


async def test_import_file_parses_batches_and_reports(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text("".join(make_log_line(TEST_IP, day=d) + "\n" for d in (1, 5, 3)))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)

    parser = LogParser(log_path=log, send_logs=True)
    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker, batch_size=2,
    )

    assert result.skipped is False
    assert result.lines_total == 3
    assert result.lines_skipped == 0
    assert result.records_written == 3
    # 3 records, batch_size 2 -> two flushes
    assert service.flush_records.await_count == 2
    # time bounds from log-line timestamps, not wall clock
    assert result.time_start is not None
    assert result.time_end is not None
    assert result.time_start.day == 1 and result.time_start.month == 8
    assert result.time_end.day == 5
    assert result.time_start.tzinfo is not None


async def test_import_file_skips_known_checksum(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text(make_log_line(TEST_IP) + "\n")

    service, FakeRepo, session_maker = _import_deps(tmp_path)

    class SeenRepo(FakeRepo):
        async def get_by_checksum(self, checksum):
            return MagicMock()  # a prior ImportJob exists

    monkeypatch.setattr(importer, "ImportJobRepository", SeenRepo)
    parser = LogParser(log_path=log, send_logs=True)

    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
    )
    assert result.skipped is True
    assert service.flush_records.await_count == 0


async def test_import_file_force_updates_existing_job(tmp_path, geoip_reader, monkeypatch):
    """--force must UPDATE the existing ImportJob row (checksum is unique), not insert."""
    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text(make_log_line(TEST_IP) + "\n")

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    prior_job = MagicMock()
    calls = {"add": 0, "update": 0}

    class SeenRepo(FakeRepo):
        async def get_by_checksum(self, checksum):
            return prior_job
        async def add(self, job, auto_commit=True):
            calls["add"] += 1
            return job
        async def update(self, job, auto_commit=True):
            calls["update"] += 1
            return job

    monkeypatch.setattr(importer, "ImportJobRepository", SeenRepo)
    parser = LogParser(log_path=log, send_logs=True)

    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker, force=True,
    )
    assert result.skipped is False
    assert service.flush_records.await_count == 1
    assert calls == {"add": 0, "update": 1}


async def test_import_file_counts_matched_records_only(tmp_path, geoip_reader, monkeypatch):
    """records_written must count only lines matching the log format, not garbage lines."""
    from geometrikks.services import importer

    log = tmp_path / "mixed.log"
    lines = [
        make_log_line(TEST_IP, day=1),
        "junk line\n",
        make_log_line(TEST_IP, day=2),
        "junk line\n",
        make_log_line(TEST_IP, day=3),
        make_log_line(TEST_IP, day=4),
    ]
    log.write_text("".join(l if l.endswith("\n") else l + "\n" for l in lines))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(log_path=log, send_logs=True)

    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
    )

    assert result.skipped is False
    assert result.lines_total == 6
    assert result.lines_skipped == 2
    assert result.records_written == 4


async def test_import_file_ignored_ips_counted_as_skipped(tmp_path, geoip_reader, monkeypatch):
    """Lines from ignore-listed IPs are dropped entirely and counted as skipped."""
    from geometrikks.services import importer

    log = tmp_path / "own.log"
    lines = [
        make_log_line(TEST_IP, day=1),
        make_log_line("81.2.69.142", day=2),  # other IP in the test mmdb
    ]
    log.write_text("".join(l + "\n" for l in lines))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(log_path=log, send_logs=True, ignore_ips=[TEST_IP])

    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
    )

    assert result.skipped is False
    assert result.lines_total == 2
    assert result.lines_skipped == 1
    assert result.records_written == 1
    # the ignored record must never reach the flush batch
    flushed = [r for call in service.flush_records.await_args_list for r in call.args[0]]
    assert all(r.ip_address != TEST_IP for r in flushed)


async def test_import_file_aborts_on_unrecognized_format(tmp_path, geoip_reader, monkeypatch):
    """A wrong-format file must abort before anything is written (debug-table flood guard)."""
    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text("not an access log line\n" * 50)

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(log_path=log, send_logs=True)

    with pytest.raises(importer.UnrecognizedLogFormatError):
        await importer.import_file(
            log, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker,
        )
    assert service.flush_records.await_count == 0


def make_gjson_line(ip: str, day: int = 3) -> str:
    return (
        '{"client_ip":"' + ip + f'","timestamp":"2024-08-{day:02d}T13:14:17+02:00","method":"GET",'
        '"path":"/index.php","protocol":"HTTP/2.0","status":"200","bytes":"1024",'
        '"host":"example.com","referrer":"","user_agent":"Mozilla/5.0","remote_user":"",'
        '"request_time":"0.002","upstream_time":"0.001","request_raw":"GET /index.php HTTP/2.0"}'
    )


async def test_import_file_geometrikks_json(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = tmp_path / "old.json.log"
    log.write_text("".join(make_gjson_line(TEST_IP, day=d) + "\n" for d in (1, 5, 3)))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(log_path=log, send_logs=True, log_format="geometrikks-json")

    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
    )
    assert result.skipped is False
    assert result.lines_total == 3
    assert result.lines_skipped == 0
    assert result.records_written == 3
    assert result.time_start is not None and result.time_start.day == 1
    assert result.time_end is not None and result.time_end.day == 5


async def test_import_file_traefik_pinned_to_geometrikks_json_is_rejected(tmp_path, geoip_reader, monkeypatch):
    """Pinning the wrong JSON format aborts before anything is written."""
    from geometrikks.services import importer

    traefik_line = (
        '{"ClientAddr":"172.19.0.1:34567","ClientHost":"203.0.113.7","DownstreamStatus":200,'
        '"Duration":45678900,"RequestMethod":"GET","RequestPath":"/","RequestProtocol":"HTTP/2.0",'
        '"StartUTC":"2026-08-07T10:34:56.123456789Z","level":"info","msg":""}\n'
    )
    log = tmp_path / "traefik.log"
    log.write_text(traefik_line * 20)

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(log_path=log, send_logs=True, log_format="geometrikks-json")

    with pytest.raises(importer.UnrecognizedLogFormatError):
        await importer.import_file(
            log, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker,
        )
    assert service.flush_records.await_count == 0
