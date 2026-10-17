"""import_loki_range against real TimescaleDB: rows, loki_imports, NULL tenant, resume."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx2
import pytest
from geoip2.database import Reader
from sqlalchemy import text

from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.loki_importer import (
    LokiImportOverlapError,
    claim_loki_range,
    import_loki_range,
)
from geometrikks.services.logsources.loki import NS, LokiSource
from tests.test_loki_source import FakeLoki

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
TEST_IP = "2.125.160.216"
QUERY = '{job="nginx"}'
# Recent so the rows sit inside the raw retention window should the policy ever run.
SINCE = (datetime.now(timezone.utc) - timedelta(days=3)).replace(minute=0, second=0, microsecond=0)


def make_log_line(ip: str, moment: datetime) -> str:
    stamp = moment.strftime("%d/%b/%Y:%H:%M:%S %z")
    return (
        f'{ip} - - [{stamp}]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


def make_source(fake: FakeLoki, tenant_id: str | None = None) -> LokiSource:
    return LokiSource(
        url="http://loki:3100", query=QUERY, label="loki:1", hostname="edge-01",
        tenant_id=tenant_id, transport=httpx2.MockTransport(fake.respond),
    )


async def test_resume_and_overlap_with_null_tenant(pg_session_maker, clean_tables) -> None:
    fake = FakeLoki()
    for hour in range(3):
        moment = SINCE + timedelta(hours=hour, minutes=30)
        fake.add_ns(int(moment.timestamp()) * NS, make_log_line(TEST_IP, moment))
    before = SINCE + timedelta(hours=3)
    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker, geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(source_label="loki", send_logs=True)

    with Reader(GEOIP_DB_PATH) as reader:

        def fail_second_window(request: httpx2.Request) -> httpx2.Response:
            if int(request.url.params["start"]) == int((SINCE + timedelta(hours=1)).timestamp()) * NS:
                raise httpx2.ConnectError("connection refused", request=request)
            return fake.respond(request)

        broken = LokiSource(
            url="http://loki:3100", query=QUERY, label="loki:1", hostname="edge-01",
            transport=httpx2.MockTransport(fail_second_window),
        )
        with pytest.raises(httpx2.HTTPError):
            await import_loki_range(
                broken, service=service, parser=parser, reader=reader,
                session_maker=pg_session_maker, since=SINCE, before=before,
            )

        result = await import_loki_range(
            make_source(fake), service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker, since=SINCE, before=before,
        )
        assert result.resumed_from == SINCE + timedelta(hours=1)
        assert result.records_written == 2

        with pytest.raises(LokiImportOverlapError):
            await import_loki_range(
                make_source(fake), service=service, parser=parser, reader=reader,
                session_maker=pg_session_maker, since=SINCE, before=before,
            )

    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT tenant_id, cursor, records_written, server FROM loki_imports"
        ))).all()
        timestamps = (await session.execute(text(
            "SELECT timestamp FROM access_logs WHERE server = 'edge-01' ORDER BY timestamp"
        ))).scalars().all()
    assert len(rows) == 1
    assert rows[0].tenant_id is None
    assert rows[0].cursor == before
    assert rows[0].records_written == 3
    assert rows[0].server == "edge-01"
    assert timestamps == [SINCE + timedelta(hours=hour, minutes=30) for hour in range(3)]


async def test_different_tenant_is_a_different_selector(pg_session_maker, clean_tables) -> None:
    fake = FakeLoki()
    before = SINCE + timedelta(hours=1)
    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker, geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(source_label="loki", send_logs=True)

    with Reader(GEOIP_DB_PATH) as reader:
        await import_loki_range(
            make_source(fake, tenant_id="team-a"), service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker, since=SINCE, before=before,
        )
        await import_loki_range(
            make_source(fake, tenant_id=None), service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker, since=SINCE, before=before,
        )

    async with pg_session_maker() as session:
        count = await session.scalar(text("SELECT count(*) FROM loki_imports"))
    assert count == 2


async def test_row_that_never_imported_anything_does_not_block_an_overlapping_range(
    pg_session_maker, clean_tables
) -> None:
    """A run that died before its first window has range_start == cursor: nothing imported."""
    fake = FakeLoki()
    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker, geoip_path=GEOIP_DB_PATH, locales=["en"],
    )
    parser = LogParser(source_label="loki", send_logs=True)
    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO loki_imports (url, tenant_id, query, server, range_start, range_end, "
            "cursor, lines_total, lines_skipped, records_written, created_at, updated_at) "
            "VALUES ('http://loki:3100', NULL, :query, 'edge-01', :start, :end, :start, 0, 0, 0, "
            "now(), now())"
        ), {"query": QUERY, "start": SINCE, "end": SINCE + timedelta(hours=4)})
        await session.commit()

    with Reader(GEOIP_DB_PATH) as reader:
        result = await import_loki_range(
            make_source(fake), service=service, parser=parser, reader=reader,
            session_maker=pg_session_maker,
            since=SINCE - timedelta(hours=1), before=SINCE + timedelta(hours=1),
        )
    assert result.resumed_from is None
    async with pg_session_maker() as session:
        count = await session.scalar(text("SELECT count(*) FROM loki_imports"))
    assert count == 2


async def test_claimed_range_survives_until_imported(pg_session_maker, clean_tables) -> None:
    fake = FakeLoki()
    moment = SINCE + timedelta(minutes=30)
    fake.add_ns(int(moment.timestamp()) * NS, make_log_line(TEST_IP, moment))
    before = SINCE + timedelta(hours=2)
    service = LogIngestionService(
        inputs=[], session_maker=pg_session_maker, geoip_path=GEOIP_DB_PATH, locales=["en"],
    )

    await claim_loki_range(
        make_source(fake), session_maker=pg_session_maker, since=SINCE, before=before
    )
    with Reader(GEOIP_DB_PATH) as reader:
        result = await import_loki_range(
            make_source(fake), service=service, parser=LogParser(source_label="loki", send_logs=True),
            reader=reader, session_maker=pg_session_maker, since=SINCE, before=before,
        )

    assert result.resumed_from is None
    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT tenant_id, cursor, records_written FROM loki_imports"
        ))).all()
    assert len(rows) == 1
    assert rows[0].tenant_id is None
    assert rows[0].cursor == before
    assert rows[0].records_written == 1


async def test_covered_start_and_unfinished_run_lookups(pg_session_maker, clean_tables) -> None:
    """The two queries the CLI's default --before rests on, with a NULL tenant."""
    from geometrikks.domain.imports.repositories import LokiImportRepository

    async with pg_session_maker() as session:
        repo = LokiImportRepository(session=session)
        assert await repo.earliest_range_start(url="http://loki:3100", tenant_id=None, query=QUERY) is None
        assert await repo.find_unfinished(
            url="http://loki:3100", tenant_id=None, query=QUERY, since=SINCE
        ) is None
        await session.execute(text(
            "INSERT INTO loki_imports (url, tenant_id, query, server, range_start, range_end, "
            "cursor, lines_total, lines_skipped, records_written, created_at, updated_at) VALUES "
            "('http://loki:3100', NULL, :query, 'edge-01', :later, :later_end, :later_end, 0, 0, 0, now(), now()), "
            "('http://loki:3100', NULL, :query, 'edge-01', :start, :end, :first_hour, 0, 0, 0, now(), now()), "
            "('http://loki:3100', NULL, :query, 'edge-01', :empty, :start, :empty, 0, 0, 0, now(), now()), "
            "('http://loki:3100', 'team-a', :query, 'edge-01', :earliest, :end, :end, 0, 0, 0, now(), now()), "
            "('http://loki:3100', 'team-a', :query, 'edge-01', :start, :end5, :start, 0, 0, 0, now(), now()), "
            "('http://other:3100', NULL, :query, 'edge-01', :start, :end6, :start, 0, 0, 0, now(), now()), "
            "('http://loki:3100', NULL, :other_query, 'edge-01', :start, :end7, :start, 0, 0, 0, now(), now())"
        ), {
            "query": QUERY, "other_query": '{job="other"}',
            "later": SINCE + timedelta(hours=2), "later_end": SINCE + timedelta(hours=3),
            "start": SINCE, "end": SINCE + timedelta(hours=4),
            "first_hour": SINCE + timedelta(hours=1), "empty": SINCE - timedelta(hours=6),
            "end5": SINCE + timedelta(hours=5), "end6": SINCE + timedelta(hours=6),
            "end7": SINCE + timedelta(hours=7),
            "earliest": SINCE - timedelta(days=1),
        })
        await session.commit()

    async with pg_session_maker() as session:
        repo = LokiImportRepository(session=session)
        # the team-a row is another selector and must not lower the result
        assert await repo.earliest_range_start(url="http://loki:3100", tenant_id=None, query=QUERY) == SINCE
        unfinished = await repo.find_unfinished(
            url="http://loki:3100", tenant_id=None, query=QUERY, since=SINCE
        )
        assert unfinished is not None
        assert unfinished.tenant_id is None
        assert unfinished.url == "http://loki:3100"
        assert unfinished.query == QUERY
        assert unfinished.range_end == SINCE + timedelta(hours=4)
        assert await repo.find_unfinished(
            url="http://loki:3100", tenant_id=None, query=QUERY, since=SINCE + timedelta(hours=2)
        ) is None

    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO loki_imports (url, tenant_id, query, server, range_start, range_end, "
            "cursor, lines_total, lines_skipped, records_written, time_start, created_at, "
            "updated_at) VALUES "
            "('http://loki:3100', NULL, :query, 'edge-01', :start, :end8, :start, 0, 0, 0, "
            ":written_from, now(), now())"
        ), {
            "query": QUERY, "start": SINCE, "end8": SINCE + timedelta(hours=8),
            "written_from": SINCE - timedelta(seconds=2),
        })
        await session.commit()

    async with pg_session_maker() as session:
        repo = LokiImportRepository(session=session)
        newest = await repo.find_unfinished(
            url="http://loki:3100", tenant_id=None, query=QUERY, since=SINCE
        )
        assert newest is not None and newest.range_end == SINCE + timedelta(hours=8)
        assert await repo.earliest_range_start(url="http://loki:3100", tenant_id=None, query=QUERY) == SINCE
        assert await repo.earliest_written_line(hostname="edge-01") == SINCE - timedelta(seconds=2)
        assert await repo.earliest_written_line(hostname="other-host") is None
