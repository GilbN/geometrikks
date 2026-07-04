"""Unit tests for LogIngestionService — no database, fake repositories."""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.ingestion.service import LogIngestionService

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"

# IPs present in the redistributable MaxMind test database (both resolve with lat/long)
TEST_DB_IPS = ["2.125.160.216", "81.2.69.142"]


def make_log_line(ip: str) -> str:
    """A line in the project's custom nginx log format (mirrors tests/valid_ipv4_log.txt)."""
    return (
        f'{ip} - - [03/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


class FakeSession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0
        self.flushes = 0

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def flush(self) -> None:
        self.flushes += 1


class FakeRepo:
    def __init__(self, session: FakeSession) -> None:
        self.session = session
        self.added: list[object] = []

    async def add(self, obj, auto_commit: bool = False):
        self.added.append(obj)
        return obj


class FakeGeoLocationRepo(FakeRepo):
    async def get_by_geohash(self, geohash: str):
        return None


def make_service(parsers: list[LogParser], **overrides) -> tuple[LogIngestionService, FakeSession]:
    session = FakeSession()
    kwargs = dict(
        parsers=parsers,
        geo_location_repo=FakeGeoLocationRepo(session),
        geo_event_repo=FakeRepo(session),
        access_log_repo=FakeRepo(session),
        access_log_debug_repo=FakeRepo(session),
        geoip_path=GEOIP_DB_PATH,
        hostname="test-host",
        batch_size=100,
        commit_interval=0.2,
    )
    kwargs.update(overrides)
    return LogIngestionService(**kwargs), session


async def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met within timeout")


def make_parser(path: Path) -> LogParser:
    return LogParser(log_path=path, send_logs=True, poll_interval=0.02, hostname="test-host")


def append_line(path: Path, line: str) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


@pytest.mark.asyncio
async def test_multi_file_tailing_ingests_from_all_sources(tmp_path: Path) -> None:
    """One tail task per file; records from every file reach the repositories.

    Tailers use production behavior (start_at_end=True), so files are created
    empty before start and lines are appended after the tailers have opened them."""
    files = [tmp_path / "a.log", tmp_path / "b.log"]
    for f in files:
        f.write_text("", encoding="utf-8")

    parsers = [make_parser(f) for f in files]
    service, session = make_service(parsers)

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)  # let tail tasks open the files
    try:
        for f, ip in zip(files, TEST_DB_IPS):
            append_line(f, make_log_line(ip))
        await wait_until(lambda: service.total_processed >= 2)
    finally:
        await service.stop(timeout=5.0)

    assert service.total_geo_records == 2
    assert service.total_log_records == 2
    # each parser handled exactly its own file
    assert [p.parsed_lines for p in parsers] == [1, 1]
    assert session.commits >= 1


@pytest.mark.asyncio
async def test_stop_drains_queue_before_exit(tmp_path: Path) -> None:
    """Records already parsed are persisted on stop, not dropped."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, session = make_service([make_parser(log_file)], batch_size=1000, commit_interval=60.0)

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    for _ in range(20):
        append_line(log_file, make_log_line(TEST_DB_IPS[0]))
    # wait for the tailer to parse everything, then stop before any interval commit
    await wait_until(lambda: service.parsed_lines >= 20)
    await service.stop(timeout=5.0)

    assert service.total_processed == 20
    assert session.commits >= 1  # final flush on stop


@pytest.mark.asyncio
async def test_missing_file_does_not_block_other_tails(tmp_path: Path) -> None:
    """A nonexistent log path is skipped (with an error log); other files still ingest.

    DISABLE_WAIT=true (conftest) makes wait_for_path return immediately."""
    good = tmp_path / "good.log"
    good.write_text("", encoding="utf-8")
    missing = tmp_path / "missing.log"

    parsers = [make_parser(missing), make_parser(good)]
    service, session = make_service(parsers)

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        append_line(good, make_log_line(TEST_DB_IPS[0]))
        await wait_until(lambda: service.total_processed >= 1)
    finally:
        await service.stop(timeout=5.0)

    assert service.total_geo_records == 1
