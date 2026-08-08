"""End-to-end ingestion against real TimescaleDB.

Covers the three design-mandated scenarios:
1. write lines -> rows land in geo_events/access_logs/geo_locations
2. simulate rotation -> tailing continues on the new file
3. poison the location cache -> flush fails, cache is evicted, next flush recovers
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from types import SimpleNamespace

from sqlalchemy import text

from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser

import pytest

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"   # resolves in the MaxMind test DB
TEST_IP_2 = "81.2.69.142"   # second location in the test DB


def make_log_line(ip: str) -> str:
    """A line in the project's custom nginx log format (mirrors tests/valid_ipv4_log.txt).

    Unlike the unit-test helper this stamps the current time: the scratch DB
    has live retention policies (raw data > 180 days is droppable), so a fixed
    2024 date could vanish if a background job fires mid-session.
    """
    ts = datetime.now(timezone.utc).strftime("%d/%b/%Y:%H:%M:%S +0000")
    return (
        f'{ip} - - [{ts}]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


def make_service(log_path: Path, session_maker, **kwargs) -> LogIngestionService:
    parser = LogParser(log_path=log_path, send_logs=True, poll_interval=0.05)
    return LogIngestionService(
        parsers=[parser],
        session_maker=session_maker,
        geoip_path=GEOIP_DB_PATH,
        locales=["en"],
        batch_size=kwargs.pop("batch_size", 5),
        commit_interval=kwargs.pop("commit_interval", 0.2),
        **kwargs,
    )


async def count(session_maker, table: str) -> int:
    async with session_maker() as session:
        result = await session.execute(text(f"SELECT COUNT(*) FROM {table}"))
        return result.scalar_one()


async def wait_for(predicate, timeout: float = 10.0, interval: float = 0.1):
    """Poll an async predicate until truthy or timeout."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("condition not met within timeout")


async def _rows_landed(session_maker, n: int) -> bool:
    return await count(session_maker, "access_logs") >= n


async def start_tailing(service: LogIngestionService) -> None:
    """Start the service and yield until the tail task has opened the file.

    start() only schedules the tail tasks; the tailer stats the file and seeks
    to its end when it first runs. Lines written before that seek are skipped,
    so tests must not write until the tailer is actually streaming.
    """
    await service.start(skip_validation=True)
    await asyncio.sleep(0.25)


async def test_lines_become_rows(tmp_path: Path, pg_session_maker, clean_tables):
    log_file = tmp_path / "access.log"
    log_file.write_text("")  # file must exist before tailing starts

    service = make_service(log_file, pg_session_maker)
    await start_tailing(service)
    try:
        with log_file.open("a") as f:
            for _ in range(10):
                f.write(make_log_line(TEST_IP) + "\n")

        await wait_for(lambda: _rows_landed(pg_session_maker, 10))
    finally:
        await service.stop(timeout=5.0)

    assert await count(pg_session_maker, "access_logs") == 10
    assert await count(pg_session_maker, "geo_events") == 10
    assert await count(pg_session_maker, "geo_locations") == 1  # same IP -> one location


async def test_rotation_is_survived(tmp_path: Path, pg_session_maker, clean_tables):
    log_file = tmp_path / "access.log"
    log_file.write_text("")

    service = make_service(log_file, pg_session_maker)
    await start_tailing(service)
    try:
        with log_file.open("a") as f:
            for _ in range(5):
                f.write(make_log_line(TEST_IP) + "\n")
        await wait_for(lambda: _rows_landed(pg_session_maker, 5))

        # Rotate: move the old file away, create a fresh one (new inode).
        os.rename(log_file, tmp_path / "access.log.1")
        log_file.write_text("")
        # Give the poll loop a moment to detect the inode change.
        await asyncio.sleep(0.5)

        with log_file.open("a") as f:
            for _ in range(5):
                f.write(make_log_line(TEST_IP_2) + "\n")
        await wait_for(lambda: _rows_landed(pg_session_maker, 10))
    finally:
        await service.stop(timeout=5.0)

    assert await count(pg_session_maker, "access_logs") == 10
    assert await count(pg_session_maker, "geo_locations") == 2


def _cache_evicted(service: LogIngestionService, geohash: str):
    async def check() -> bool:
        return service._location_cache.get(geohash) != 999999
    return check


async def test_poisoned_location_cache_recovers(tmp_path: Path, pg_session_maker, clean_tables):
    """A stale cached location id (FK violation) must not poison ingestion forever.

    This is the Phase-1a bug class: cache held an id whose row never
    committed. We simulate it by planting a bogus id for the geohash the
    test IP resolves to, then asserting the service recovers on its own.
    """
    log_file = tmp_path / "access.log"
    log_file.write_text("")

    service = make_service(log_file, pg_session_maker, batch_size=1, commit_interval=0.1)

    # Resolve the geohash the same way the parser will.
    import geohash2
    from geoip2.database import Reader

    with Reader(GEOIP_DB_PATH) as reader:
        city = reader.city(TEST_IP)
        geohash = geohash2.encode(city.location.latitude, city.location.longitude)

    # Plant the poison: id 999999 does not exist in geo_locations.
    service._location_cache[geohash] = 999999

    await start_tailing(service)
    try:
        with log_file.open("a") as f:
            f.write(make_log_line(TEST_IP) + "\n")

        # First flush fails on FK; the rollback path must evict the geohash.
        await wait_for(_cache_evicted(service, geohash), timeout=5.0)

        # Feed another line: with the cache clean, this one must land.
        with log_file.open("a") as f:
            f.write(make_log_line(TEST_IP) + "\n")
        await wait_for(lambda: _rows_landed(pg_session_maker, 1))
    finally:
        await service.stop(timeout=5.0)

    assert await count(pg_session_maker, "geo_events") >= 1
    assert service._location_cache.get(geohash) != 999999


async def test_debug_entry_carries_denormalized_access_log_context(
    pg_session_maker, clean_tables
) -> None:
    """A debug row written alongside an access log copies its context columns.

    The debug list reads these columns instead of joining access_logs, so an
    ingestion path that leaves them NULL silently blanks the whole table.
    """
    access_log = AccessLog(
        timestamp=datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc),
        ip_address="203.0.113.7",
        method="GET",
        url="/probe",
        host="example.com",
        status_code=418,
        bytes_sent=100,
        request_time=0.01,
        country_code="NO",
        country_name="Norway",
        city="Oslo",
        user_agent="curl/8.0",
    )

    async with pg_session_maker() as session:
        session.add(access_log)
        await session.flush()

        debug = AccessLogDebug(
            access_log_id=access_log.id,
            raw_line="raw",
            is_malformed=True,
            parse_error="boom",
            log_timestamp=access_log.timestamp,
            ip_address=str(access_log.ip_address),
            method=access_log.method,
            url=access_log.url,
            host=access_log.host,
            status_code=access_log.status_code,
            country_code=access_log.country_code,
            country_name=access_log.country_name,
            city=access_log.city,
            user_agent=access_log.user_agent,
        )
        session.add(debug)
        await session.commit()

        row = (
            await session.execute(
                text(
                    "SELECT log_timestamp, host(ip_address) AS ip, method, url, host, "
                    " status_code, country_code, country_name, city, user_agent "
                    "FROM access_log_debug WHERE access_log_id = :log_id"
                ),
                {"log_id": access_log.id},
            )
        ).one()

    assert row.log_timestamp == datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    assert row.ip == "203.0.113.7"
    assert row.method == "GET"
    assert row.url == "/probe"
    assert row.host == "example.com"
    assert row.status_code == 418
    assert row.country_code == "NO"
    assert row.country_name == "Norway"
    assert row.city == "Oslo"
    assert row.user_agent == "curl/8.0"


async def test_create_debug_entry_copies_context_from_access_log() -> None:
    """_create_debug_entry must copy context, not leave the new columns NULL."""
    added: list[AccessLogDebug] = []

    class _Session:
        def add(self, obj: object) -> None:
            added.append(cast("AccessLogDebug", obj))

        async def flush(self) -> None:
            return None

    class _Repo:
        session = _Session()

    class _Repos:
        access_log = _Repo()
        access_log_debug = _Repo()

    access_log = AccessLog(
        id=99,
        timestamp=datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc),
        ip_address="203.0.113.7",
        method="POST",
        url="/x",
        host="h.example",
        status_code=500,
        bytes_sent=1,
        request_time=0.0,
        country_code="SE",
        country_name="Sweden",
        city="Malmo",
        user_agent="agent/1",
    )

    record = SimpleNamespace(raw_line="raw line", parse_error="err", is_malformed=True)

    service = LogIngestionService.__new__(LogIngestionService)
    await service._create_debug_entry(record, access_log, _Repos())  # ty: ignore[invalid-argument-type]

    assert len(added) == 1
    entry = added[0]
    assert entry.log_timestamp == access_log.timestamp
    assert entry.ip_address == "203.0.113.7"
    assert entry.method == "POST"
    assert entry.status_code == 500
    assert entry.country_code == "SE"
    assert entry.city == "Malmo"
    assert entry.user_agent == "agent/1"


async def test_create_debug_entry_leaves_context_null_when_unlinked() -> None:
    """A line that never parsed into an access log keeps NULL context."""
    added: list[AccessLogDebug] = []

    class _Session:
        def add(self, obj: object) -> None:
            added.append(cast("AccessLogDebug", obj))

        async def flush(self) -> None:
            return None

    class _Repo:
        session = _Session()

    class _Repos:
        access_log = _Repo()
        access_log_debug = _Repo()

    record = SimpleNamespace(raw_line="junk", parse_error="no method", is_malformed=True)

    service = LogIngestionService.__new__(LogIngestionService)
    await service._create_debug_entry(record, None, _Repos())  # ty: ignore[invalid-argument-type]

    assert len(added) == 1
    entry = added[0]
    assert entry.access_log_id is None
    assert entry.log_timestamp is None
    assert entry.ip_address is None
    assert entry.status_code is None
