"""Unit tests for LogIngestionService — no database, fake repositories."""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.ingestion.service import IngestionRepos, LogIngestionService

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
        self.closed = False

    async def __aenter__(self) -> "FakeSession":
        return self

    async def __aexit__(self, *exc_info) -> None:
        self.closed = True

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def flush(self) -> None:
        self.flushes += 1


class FakeRepo:
    _next_id = 1

    def __init__(self, session: FakeSession) -> None:
        self.session = session
        self.added: list[object] = []

    async def add(self, obj, auto_commit: bool = False):
        if getattr(obj, "id", None) is None:
            obj.id = FakeRepo._next_id
            FakeRepo._next_id += 1
        self.added.append(obj)
        return obj


class FakeGeoLocationRepo(FakeRepo):
    async def get_by_geohash(self, geohash: str):
        return None


class FakeRepos:
    """Stands in for IngestionRepos; shared `added` lists survive across flush sessions."""

    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []
        session_placeholder = FakeSession()
        self.geo_location = FakeGeoLocationRepo(session_placeholder)
        self.geo_event = FakeRepo(session_placeholder)
        self.access_log = FakeRepo(session_placeholder)
        self.access_log_debug = FakeRepo(session_placeholder)

    def factory(self, session: FakeSession) -> "FakeRepos":
        self.sessions.append(session)
        for repo in (self.geo_location, self.geo_event, self.access_log, self.access_log_debug):
            repo.session = session
        return self


def make_service(parsers: list[LogParser], **overrides) -> tuple[LogIngestionService, FakeRepos, list[FakeSession]]:
    repos = FakeRepos()
    sessions: list[FakeSession] = []

    def session_maker() -> FakeSession:
        session = FakeSession()
        sessions.append(session)
        return session

    kwargs = dict(
        parsers=parsers,
        session_maker=session_maker,
        geoip_path=GEOIP_DB_PATH,
        repos_factory=repos.factory,
        hostname="test-host",
        batch_size=100,
        commit_interval=0.2,
    )
    kwargs.update(overrides)
    return LogIngestionService(**kwargs), repos, sessions


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
    service, repos, sessions = make_service(parsers)

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
    assert any(s.commits for s in sessions)


@pytest.mark.asyncio
async def test_stop_drains_queue_before_exit(tmp_path: Path) -> None:
    """Records already parsed are persisted on stop, not dropped."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service([make_parser(log_file)], batch_size=1000, commit_interval=60.0)

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    for _ in range(20):
        append_line(log_file, make_log_line(TEST_DB_IPS[0]))
    # wait for the tailer to parse everything, then stop before any interval commit
    await wait_until(lambda: service.parsed_lines >= 20)
    await service.stop(timeout=5.0)

    assert service.total_processed == 20
    assert any(s.commits for s in sessions)  # final flush on stop


@pytest.mark.asyncio
async def test_missing_file_does_not_block_other_tails(tmp_path: Path) -> None:
    """A nonexistent log path is skipped (with an error log); other files still ingest.

    DISABLE_WAIT=true (conftest) makes wait_for_path return immediately."""
    good = tmp_path / "good.log"
    good.write_text("", encoding="utf-8")
    missing = tmp_path / "missing.log"

    parsers = [make_parser(missing), make_parser(good)]
    service, repos, sessions = make_service(parsers)

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        append_line(good, make_log_line(TEST_DB_IPS[0]))
        await wait_until(lambda: service.total_processed >= 1)
    finally:
        await service.stop(timeout=5.0)

    assert service.total_geo_records == 1


@pytest.mark.asyncio
async def test_each_flush_uses_a_fresh_session(tmp_path: Path) -> None:
    """Two flush cycles → two distinct sessions, each committed and closed."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service(
        [make_parser(log_file)], batch_size=1, commit_interval=60.0
    )
    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: len(sessions) >= 1 and sessions[0].commits == 1)

        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[1]) + "\n")
        await wait_until(lambda: len(sessions) >= 2 and sessions[1].commits == 1)
    finally:
        await service.stop(timeout=5.0)

    assert all(s.closed for s in sessions[:2])
    assert sessions[0] is not sessions[1]


@pytest.mark.asyncio
async def test_no_session_opened_while_idle(tmp_path: Path) -> None:
    """Idle service (no records) never opens a database session."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, _repos, sessions = make_service([make_parser(log_file)], commit_interval=0.05)
    await service.start(skip_validation=True)
    await asyncio.sleep(0.3)  # several commit intervals with nothing to write
    await service.stop(timeout=5.0)

    assert sessions == []
