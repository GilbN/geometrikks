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


@pytest.mark.asyncio
async def test_start_twice_spawns_no_duplicate_tasks(tmp_path: Path) -> None:
    """Two back-to-back start() calls (no await in between) must not spawn a
    second set of tail tasks + consumer; the second call is a no-op."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service([make_parser(log_file)])

    await service.start(skip_validation=True)
    await service.start(skip_validation=True)  # immediately again, no sleep in between

    # Check the actual running tasks, not just the service's own bookkeeping:
    # a buggy second start() reassigns service._tail_tasks to a fresh list,
    # which would make a len() check on it pass even though the first
    # generation of tasks is still alive and orphaned (untracked).
    all_task_names = [t.get_name() for t in asyncio.all_tasks() if not t.done()]
    tail_tasks = [n for n in all_task_names if n.startswith("log-tail:")]
    ingestion_tasks = [n for n in all_task_names if n == "log-ingestion"]
    assert len(tail_tasks) == 1, f"expected 1 tail task, found {tail_tasks}"
    assert len(ingestion_tasks) == 1, f"expected 1 ingestion task, found {ingestion_tasks}"
    assert len(service._tail_tasks) == 1

    await service.stop(timeout=5.0)


@pytest.mark.asyncio
async def test_poison_record_evicts_uncommitted_location_from_cache(tmp_path: Path) -> None:
    """A failed flush evicts locations cached during that flush, so the next
    occurrence of the same geohash re-creates the row instead of poison-looping."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service(
        [make_parser(log_file)], batch_size=1, commit_interval=60.0
    )

    # First geo-event add fails (simulates FK/integrity error); later ones succeed
    original_add = repos.geo_event.add
    fail_once = {"armed": True}

    async def flaky_add(obj, auto_commit: bool = False):
        if fail_once["armed"]:
            fail_once["armed"] = False
            raise RuntimeError("simulated integrity error")
        return await original_add(obj, auto_commit=auto_commit)

    repos.geo_event.add = flaky_add

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: any(s.rollbacks for s in sessions))

        # cache must NOT contain the geohash whose insert was rolled back
        assert service._location_cache == {}
        assert service._uncommitted_geohashes == set()

        # same IP again: location is re-created and the geo event lands this time
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: len(repos.geo_event.added) == 1)
    finally:
        await service.stop(timeout=5.0)

    # location was inserted twice (first attempt rolled back), event exactly once
    assert len(repos.geo_location.added) == 2


@pytest.mark.asyncio
async def test_rollback_evicts_all_uncommitted_geohashes_in_batch(tmp_path: Path) -> None:
    """Within one flush of a multi-record batch, a later record's failure must
    evict ALL uncommitted locations cached during that flush - not just its own.

    Record A (processed first) creates+caches a new location (uncommitted).
    Record B (same batch, same geohash) reuses the cached id but then fails
    while adding its GeoEvent. The per-record rollback must also evict A's
    entry, or the next occurrence of the same geohash poison-loops on a
    location id that never made it to the database.
    """
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service(
        [make_parser(log_file)], batch_size=2, commit_interval=60.0
    )

    # First geo_event.add call (record A) succeeds; second call (record B)
    # fails once; every call after that succeeds again.
    original_add = repos.geo_event.add
    call_count = {"n": 0}

    async def flaky_add(obj, auto_commit: bool = False):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RuntimeError("simulated integrity error")
        return await original_add(obj, auto_commit=auto_commit)

    repos.geo_event.add = flaky_add

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        # Both lines share the same IP -> same geohash, and both are appended
        # before batch_size(2) can be reached, so they land in ONE flush.
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: any(s.rollbacks for s in sessions))

        # record A's cached-but-uncommitted location must be evicted too,
        # not just record B's.
        assert service._location_cache == {}
        assert service._uncommitted_geohashes == set()

        # a fresh occurrence of the same IP: location is re-created and the
        # event lands, proving no poison loop from a leftover cache entry.
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: service.parsed_lines >= 3)
    finally:
        await service.stop(timeout=5.0)

    assert sum(s.rollbacks for s in sessions) == 1
    # record A's event + the recovered record's event (B's event never landed)
    assert len(repos.geo_event.added) == 2
    # first insert (record A) + re-created insert after eviction
    assert len(repos.geo_location.added) == 2


@pytest.mark.asyncio
async def test_committed_locations_survive_in_cache_as_ids(tmp_path: Path) -> None:
    """After a successful commit the cache holds plain ids, and a repeat of the
    same geohash creates no second GeoLocation row."""
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
        await wait_until(lambda: any(s.commits for s in sessions))

        assert list(service._location_cache.values()) and all(
            isinstance(v, int) for v in service._location_cache.values()
        )
        assert service._uncommitted_geohashes == set()

        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: len(repos.geo_event.added) == 2)
    finally:
        await service.stop(timeout=5.0)

    assert len(repos.geo_location.added) == 1  # second event reused the cached id
