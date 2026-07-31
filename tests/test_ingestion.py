"""Unit tests for LogIngestionService — no database, fake repositories."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from geohash2 import encode
from geoip2.database import Reader

from geometrikks.domain.geo.models import GeoEvent, GeoLocation
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logparser.schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog
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
    """Models deferred-insert semantics: session.add() buffers, flush assigns
    ids, commit routes objects to the per-model `added` lists, rollback
    discards pending. Failure injection lives on FakeRepos (fail_next_commits,
    fail_flush_calls) since real integrity errors surface at flush/commit."""

    def __init__(self, repos: "FakeRepos") -> None:
        self.repos = repos
        self.pending: list[object] = []
        self.commits = 0
        self.rollbacks = 0
        self.flushes = 0
        self.closed = False

    async def __aenter__(self) -> "FakeSession":
        return self

    async def __aexit__(self, *exc_info) -> None:
        self.closed = True

    def add(self, obj) -> None:
        self.pending.append(obj)

    def _assign_ids(self) -> None:
        for obj in self.pending:
            if getattr(obj, "id", None) is None:
                obj.id = FakeRepos.next_id()

    async def commit(self) -> None:
        if self.repos.fail_next_commits:
            self.repos.fail_next_commits -= 1
            raise RuntimeError("simulated integrity error at commit")
        self.commits += 1
        self._assign_ids()
        for obj in self.pending:
            self.repos.route(obj)
        self.pending.clear()

    async def rollback(self) -> None:
        self.rollbacks += 1
        self.pending.clear()

    async def flush(self) -> None:
        self.flushes += 1
        self.repos.flush_calls += 1
        if self.repos.flush_calls in self.repos.fail_flush_calls:
            raise RuntimeError("simulated integrity error at flush")
        self._assign_ids()


class FakeRepo:
    def __init__(self, session: FakeSession | None) -> None:
        self.session = session
        self.added: list[object] = []  # committed objects of this repo's model


class FakeGeoLocationRepo(FakeRepo):
    async def get_by_geohash(self, geohash: str):
        return None


class FakeRepos:
    """Stands in for IngestionRepos; shared `added` lists survive across flush sessions."""

    _id_counter = 0

    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []
        self.geo_location = FakeGeoLocationRepo(None)
        self.geo_event = FakeRepo(None)
        self.access_log = FakeRepo(None)
        self.access_log_debug = FakeRepo(None)
        # failure injection: consumed by FakeSession
        self.fail_next_commits = 0
        self.fail_flush_calls: set[int] = set()  # 1-based flush call numbers
        self.flush_calls = 0

    @classmethod
    def next_id(cls) -> int:
        cls._id_counter += 1
        return cls._id_counter

    def route(self, obj) -> None:
        if isinstance(obj, GeoLocation):
            self.geo_location.added.append(obj)
        elif isinstance(obj, GeoEvent):
            self.geo_event.added.append(obj)
        elif isinstance(obj, AccessLog):
            self.access_log.added.append(obj)
        elif isinstance(obj, AccessLogDebug):
            self.access_log_debug.added.append(obj)

    def factory(self, session: FakeSession) -> "FakeRepos":
        self.sessions.append(session)
        for repo in (self.geo_location, self.geo_event, self.access_log, self.access_log_debug):
            repo.session = session
        return self


def make_service(parsers: list[LogParser], **overrides) -> tuple[LogIngestionService, FakeRepos, list[FakeSession]]:
    repos = FakeRepos()
    sessions: list[FakeSession] = []

    def session_maker() -> FakeSession:
        session = FakeSession(repos)
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
async def test_all_tails_dead_stops_service_and_clears_is_running(tmp_path: Path) -> None:
    """When every tail task exits (all log files missing), the consumer must
    shut down and is_running must flip to False so /health reports degraded.

    DISABLE_WAIT=true (conftest) makes wait_for_path return immediately."""
    missing = tmp_path / "missing.log"
    service, _repos, _sessions = make_service([make_parser(missing)])

    await service.start(skip_validation=True)
    try:
        await wait_until(lambda: not service.is_running)
        assert not service.is_task_running
    finally:
        await service.stop(timeout=5.0)


@pytest.mark.asyncio
async def test_last_record_at_tracks_ingestion_activity(tmp_path: Path) -> None:
    """last_record_at is None until a record is consumed, then a recent UTC
    timestamp (surfaced in /health as the last-event-ingested signal)."""
    from datetime import datetime, timezone

    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")
    service, _repos, _sessions = make_service([make_parser(log_file)])

    assert service.last_record_at is None
    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        before = datetime.now(timezone.utc)
        append_line(log_file, make_log_line(TEST_DB_IPS[0]))
        await wait_until(lambda: service.total_processed >= 1)
        assert service.last_record_at is not None
        assert service.last_record_at >= before
        assert service.last_record_at.tzinfo is not None
    finally:
        await service.stop(timeout=5.0)


@pytest.mark.asyncio
async def test_mid_flight_file_deletion_flags_missing_and_recovers(tmp_path: Path, caplog) -> None:
    """Deleting a tailed file mid-flight must not spam warnings or kill the
    tailer: the parser flags file_missing (surfaced as service.missing_files
    for /health), logs the disappearance once, keeps waiting, and resumes
    when the file reappears (new inode -> rotation reopen path)."""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")
    parser = make_parser(log_file)
    service, _repos, _sessions = make_service([parser])

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)  # let the tailer open the file
    try:
        append_line(log_file, make_log_line(TEST_DB_IPS[0]))
        await wait_until(lambda: service.total_processed >= 1)

        log_file.unlink()
        await wait_until(lambda: parser.file_missing)
        assert service.missing_files == [str(log_file)]
        assert service.is_running  # waiting for the file, not dead

        # Many poll intervals later the disappearance is still logged once.
        await asyncio.sleep(0.3)
        missing_logs = [
            r for r in caplog.records if "no longer exists" in r.getMessage()
        ]
        assert len(missing_logs) == 1

        # Reappearing file (new inode) resumes tailing and clears the flag.
        log_file.write_text("", encoding="utf-8")
        await wait_until(lambda: not parser.file_missing)
        assert service.missing_files == []
        append_line(log_file, make_log_line(TEST_DB_IPS[1]))
        await wait_until(lambda: service.total_processed >= 2)
    finally:
        await service.stop(timeout=5.0)


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
    """A failed batch commit evicts locations cached during that flush, so the
    next occurrence of the same geohash re-creates the row instead of
    poison-looping. (Inserts are deferred, so an FK/integrity error surfaces
    at commit.)"""
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service(
        [make_parser(log_file)], batch_size=1, commit_interval=60.0
    )

    # First batch commit fails (simulates FK/integrity error); later ones succeed
    repos.fail_next_commits = 1

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

    # only the second attempt committed (first location+event were rolled back)
    assert len(repos.geo_location.added) == 1


@pytest.mark.asyncio
async def test_rollback_evicts_all_uncommitted_geohashes_in_batch(tmp_path: Path) -> None:
    """Within one flush of a multi-record batch, a later record's failure must
    evict ALL uncommitted locations cached during that flush - not just its own.

    Record A (processed first) creates+caches a new location (uncommitted).
    Record B (same batch, different geohash) fails while flushing its own new
    location. The per-record rollback must also evict A's entry, or the next
    occurrence of A's geohash poison-loops on a location id that never made it
    to the database.
    """
    log_file = tmp_path / "a.log"
    log_file.write_text("", encoding="utf-8")

    service, repos, sessions = make_service(
        [make_parser(log_file)], batch_size=2, commit_interval=60.0
    )

    # Location flushes: record A's succeeds (call 1), record B's fails
    # (call 2), the recovered record's succeeds again (call 3).
    repos.fail_flush_calls = {2}

    await service.start(skip_validation=True)
    await asyncio.sleep(0.1)
    try:
        # Two different IPs -> two new geohashes, and both lines are appended
        # before batch_size(2) can be reached, so they land in ONE flush.
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
            fh.write(make_log_line(TEST_DB_IPS[1]) + "\n")
        await wait_until(lambda: any(s.rollbacks for s in sessions))

        # record A's cached-but-uncommitted location must be evicted too,
        # not just record B's.
        assert service._location_cache == {}
        assert service._uncommitted_geohashes == set()

        # a fresh occurrence of A's IP: location is re-created and the
        # event lands, proving no poison loop from a leftover cache entry.
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(make_log_line(TEST_DB_IPS[0]) + "\n")
        await wait_until(lambda: service.parsed_lines >= 3)
    finally:
        await service.stop(timeout=5.0)

    assert sum(s.rollbacks for s in sessions) == 1
    # only the recovered record committed: A's event was discarded by the
    # rollback (deferred inserts), B's never landed at all
    assert len(repos.geo_event.added) == 1
    assert len(repos.geo_location.added) == 1


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


@pytest.mark.asyncio
async def test_flush_records_writes_through_batch_machinery() -> None:
    """flush_records must reuse _flush_batch (cache + rollback semantics)."""
    service, _repos, sessions = make_service([])

    # Build ParsedLogRecord objects for TEST_DB_IPS
    # Using realistic geo data from the test database
    ts = datetime.now(timezone.utc)
    records = [
        ParsedLogRecord(
            ip_address=TEST_DB_IPS[0],
            geo_data=ParsedGeoData(
                latitude=51.5142,
                longitude=-0.0931,
                geohash=encode(51.5142, -0.0931),
                country_code="GB",
                country_name="United Kingdom",
                state="England",
                state_code="ENG",
                city="London",
                postal_code="EC1A",
                timezone="Europe/London",
                timestamp=ts,
            ),
            access_log=ParsedAccessLog(
                timestamp=ts,
                ip_address=TEST_DB_IPS[0],
                remote_user=None,
                method="GET",
                url="/",
                http_version="HTTP/1.1",
                status_code=200,
                bytes_sent=1024,
                referrer=None,
                user_agent="test-agent",
                request_time=0.002,
                upstream_response_time=0.001,
                host="example.com",
                country_code="GB",
                country_name="United Kingdom",
                city="London",
            ),
            raw_line=make_log_line(TEST_DB_IPS[0]),
            is_malformed=False,
        ),
        ParsedLogRecord(
            ip_address=TEST_DB_IPS[1],
            geo_data=ParsedGeoData(
                latitude=51.4545,
                longitude=5.8520,
                geohash=encode(51.4545, 5.8520),
                country_code="NL",
                country_name="Netherlands",
                state="North Holland",
                state_code="NH",
                city="Amsterdam",
                postal_code="1000",
                timezone="Europe/Amsterdam",
                timestamp=ts,
            ),
            access_log=ParsedAccessLog(
                timestamp=ts,
                ip_address=TEST_DB_IPS[1],
                remote_user=None,
                method="POST",
                url="/api",
                http_version="HTTP/1.1",
                status_code=201,
                bytes_sent=512,
                referrer="https://example.com",
                user_agent="test-agent-2",
                request_time=0.003,
                upstream_response_time=0.002,
                host="api.example.com",
                country_code="NL",
                country_name="Netherlands",
                city="Amsterdam",
            ),
            raw_line=make_log_line(TEST_DB_IPS[1]),
            is_malformed=False,
        ),
    ]

    await service.flush_records(records)

    assert service.pending_records == 0
    assert len(sessions) == 1 and sessions[0].commits == 1
    assert service.total_processed == len(records)


def make_parsed_record(ip: str) -> ParsedLogRecord:
    """Minimal geo+log record (same field shape as the flush_records test data)."""
    ts = datetime.now(timezone.utc)
    return ParsedLogRecord(
        ip_address=ip,
        geo_data=ParsedGeoData(
            latitude=51.5142, longitude=-0.0931, geohash=encode(51.5142, -0.0931),
            country_code="GB", country_name="United Kingdom", city="London",
            timestamp=ts,
        ),
        access_log=ParsedAccessLog(
            timestamp=ts, ip_address=ip, remote_user=None, method="GET",
            url="/", http_version="HTTP/1.1", status_code=200, bytes_sent=1024,
            referrer=None, user_agent="test-agent", request_time=0.002,
            upstream_response_time=None, host="example.com",
            country_code="GB", country_name="United Kingdom", city="London",
        ),
        raw_line=make_log_line(ip),
    )


async def test_pubsub_subscribers_receive_committed_records() -> None:
    service, _repos, _sessions = make_service([])
    q = service.subscribe()
    records = [make_parsed_record(ip) for ip in TEST_DB_IPS]

    await service.flush_records(records)

    got = [q.get_nowait() for _ in range(len(records))]
    assert [r.ip_address for r in got] == [r.ip_address for r in records]


async def test_pubsub_unsubscribed_queue_gets_nothing() -> None:
    service, _repos, _sessions = make_service([])
    q = service.subscribe()
    service.unsubscribe(q)
    await service.flush_records([make_parsed_record(TEST_DB_IPS[0])])
    assert q.empty()


async def test_pubsub_failed_commit_publishes_nothing() -> None:
    service, repos, _sessions = make_service([])
    repos.fail_next_commits = 1
    q = service.subscribe()
    await service.flush_records([make_parsed_record(TEST_DB_IPS[0])])
    assert q.empty(), "post-commit publish only — rolled-back records must not stream"


async def test_pubsub_full_subscriber_drops_oldest_not_ingestion() -> None:
    service, _repos, _sessions = make_service([])
    q = service.subscribe(maxsize=1)
    r1, r2 = (make_parsed_record(ip) for ip in TEST_DB_IPS)
    await service.flush_records([r1])
    await service.flush_records([r2])   # must not block or raise
    assert q.qsize() == 1
    assert q.get_nowait().ip_address == r2.ip_address
