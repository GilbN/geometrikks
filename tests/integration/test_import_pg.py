"""Full import path against real TimescaleDB (gz file -> rows -> CAGGs -> import_jobs)."""
from __future__ import annotations

import gzip
from pathlib import Path

from geoip2.database import Reader
from sqlalchemy import text

from geometrikks.services.importer import import_file
from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"


def make_log_line(ip: str, day: int) -> str:
    return (
        f'{ip} - - [{day:02d}/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


async def test_gz_import_lands_rows_and_records_job(tmp_path: Path, pg_session_maker, clean_tables):
    gz_file = tmp_path / "access.log.1.gz"
    with gzip.open(gz_file, "wt") as f:
        for day in range(1, 6):
            f.write(make_log_line(TEST_IP, day) + "\n")

    service = LogIngestionService(
        parsers=[], session_maker=pg_session_maker,
        geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(log_path=gz_file, send_logs=True)

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
        ts = (await session.execute(text("SELECT MIN(timestamp), MAX(timestamp) FROM access_logs"))).one()
    assert logs == 5, "no duplicate rows from the second run"
    assert jobs == 1
    assert ts[0].day == 1 and ts[1].day == 5, "log-line timestamps, not wall clock"
