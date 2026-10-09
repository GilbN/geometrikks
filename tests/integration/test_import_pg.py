"""Full import path against real TimescaleDB (gz file -> rows -> CAGGs -> import_jobs)."""
from __future__ import annotations

import gzip
from datetime import datetime, timedelta, timezone
from pathlib import Path

from geoip2.database import Reader
from sqlalchemy import text

from geometrikks.services.importer import import_file
from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.formats import IMPORT_FORMATS
from geometrikks.services.logparser.logparser import LogParser

import pytest

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"

# Wall-clock-relative so rows stay inside the raw retention window (180 days
# by default) — the scratch DB has live retention policies that drop chunks
# with older timestamps mid-test. Same convention as test_repositories_pg.py.
DAYS = [datetime.now(timezone.utc) - timedelta(days=d) for d in range(5, 0, -1)]


def make_log_line(ip: str, ts: datetime) -> str:
    stamp = ts.strftime("%d/%b/%Y:%H:%M:%S %z")
    return (
        f'{ip} - - [{stamp}]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


async def test_gz_import_lands_rows_and_records_job(tmp_path: Path, pg_session_maker, clean_tables):
    gz_file = tmp_path / "access.log.1.gz"
    with gzip.open(gz_file, "wt") as f:
        for ts in DAYS:
            f.write(make_log_line(TEST_IP, ts) + "\n")

    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker,
        geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(source_label=str(gz_file), send_logs=True)

    with Reader(GEOIP_DB_PATH) as reader:
        result = await import_file(
            gz_file, service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker, batch_size=2,
        )
        assert result.records_written == 5

        # second run: checksum protection
        result2 = await import_file(
            gz_file, service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker,
        )
        assert result2.skipped is True

    async with pg_session_maker() as session:
        logs = (await session.execute(text("SELECT COUNT(*) FROM access_logs"))).scalar_one()
        jobs = (await session.execute(text("SELECT COUNT(*) FROM import_jobs"))).scalar_one()
        ts_bounds = (await session.execute(
            text("SELECT MIN(timestamp), MAX(timestamp) FROM access_logs")
        )).one()
    assert logs == 5, "no duplicate rows from the second run"
    assert jobs == 1
    # Log-line timestamps, not wall clock (second-precision: %S drops microseconds)
    assert ts_bounds[0] == DAYS[0].replace(microsecond=0)
    assert ts_bounds[1] == DAYS[-1].replace(microsecond=0)


def make_npm_line(ip: str, ts: datetime) -> str:
    stamp = ts.strftime("%d/%b/%Y:%H:%M:%S %z")
    return (
        f'[{stamp}] - 200 200 - GET https npm.example.com "/index.php" '
        f'[Client {ip}] [Length 1024] [Gzip -] [Sent-to app] "Mozilla/5.0" "-"'
    )


async def test_npm_import_stops_at_before(tmp_path: Path, pg_session_maker, clean_tables):
    log = tmp_path / "proxy-host-1_access.log"
    log.write_text("".join(make_npm_line(TEST_IP, ts) + "\n" for ts in DAYS))

    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker,
        geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(source_label=str(log), send_logs=True, formats=IMPORT_FORMATS)

    with Reader(GEOIP_DB_PATH) as reader:
        result = await import_file(
            log, service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker, before=DAYS[3].replace(microsecond=0),
        )
    assert result.records_written == 3
    assert result.lines_after_cutoff == 2

    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT log_format, host, request_time, COUNT(*), MAX(timestamp) "
            "FROM access_logs GROUP BY log_format, host, request_time"
        ))).all()
        geo_events = (await session.execute(text("SELECT COUNT(*) FROM geo_events"))).scalar_one()
    assert len(rows) == 1
    log_format, host, request_time, count, newest = rows[0]
    assert (log_format, host, request_time, count) == ("npm", "npm.example.com", None, 3)
    assert newest == DAYS[2].replace(microsecond=0)
    assert geo_events == 3


async def test_later_cutoffs_import_each_line_once(tmp_path: Path, pg_session_maker, clean_tables):
    gz_file = tmp_path / "access.log.2.gz"
    with gzip.open(gz_file, "wt") as f:
        for ts in DAYS:
            f.write(make_log_line(TEST_IP, ts) + "\n")

    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker,
        geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    written = []
    with Reader(GEOIP_DB_PATH) as reader:
        for before in (DAYS[2].replace(microsecond=0), DAYS[4].replace(microsecond=0), None):
            result = await import_file(
                gz_file, service=service,
                parser=LogParser(source_label=str(gz_file), send_logs=True),
                reader=reader, session_maker=pg_session_maker, before=before,
            )
            written.append(result.records_written)

    assert written == [2, 2, 1]
    async with pg_session_maker() as session:
        logs = (await session.execute(text("SELECT COUNT(*) FROM access_logs"))).scalar_one()
        job = (await session.execute(text(
            "SELECT records_written, cutoff FROM import_jobs"
        ))).one()
    assert logs == 5
    assert tuple(job) == (5, None)
