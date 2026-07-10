"""Batch importer: checksum skip, gzip transparency, batching, time bounds."""
from __future__ import annotations

import gzip
import hashlib
from datetime import timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.logparser import LogParser

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
