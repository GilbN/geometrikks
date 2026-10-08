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

    parser = LogParser(source_label=str(log), send_logs=True)
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
            return MagicMock(cutoff=None)  # a prior ImportJob exists

    monkeypatch.setattr(importer, "ImportJobRepository", SeenRepo)
    parser = LogParser(source_label=str(log), send_logs=True)

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
    parser = LogParser(source_label=str(log), send_logs=True)

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
    parser = LogParser(source_label=str(log), send_logs=True)

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
    parser = LogParser(source_label=str(log), send_logs=True, ignore_ips=[TEST_IP])

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
    parser = LogParser(source_label=str(log), send_logs=True)

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
    parser = LogParser(source_label=str(log), send_logs=True, log_format="geometrikks-json")

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


def make_caddy_line(ip: str, day: int = 3) -> str:
    return (
        '{"level":"info","ts":"2024-08-' + f"{day:02d}" + 'T13:14:17+02:00",'
        '"logger":"http.log.access.log0","msg":"handled request",'
        '"request":{"remote_ip":"' + ip + '","client_ip":"' + ip + '",'
        '"proto":"HTTP/2.0","method":"GET","host":"caddy.example.com","uri":"/index.php",'
        '"headers":{"User-Agent":["Mozilla/5.0"]}},'
        '"user_id":"","duration":0.002,"size":1024,"status":200}'
    )


async def test_import_file_caddy_json(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = tmp_path / "old.caddy.log"
    log.write_text("".join(make_caddy_line(TEST_IP, day=d) + "\n" for d in (1, 5, 3)))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)
    parser = LogParser(source_label=str(log), send_logs=True, log_format="caddy-json")

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


async def test_import_file_traefik_pinned_to_caddy_json_is_rejected(tmp_path, geoip_reader, monkeypatch):
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
    parser = LogParser(source_label=str(log), send_logs=True, log_format="caddy-json")

    with pytest.raises(importer.UnrecognizedLogFormatError):
        await importer.import_file(
            log, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker,
        )
    assert service.flush_records.await_count == 0


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
    parser = LogParser(source_label=str(log), send_logs=True, log_format="geometrikks-json")

    with pytest.raises(importer.UnrecognizedLogFormatError):
        await importer.import_file(
            log, service=service, parser=parser, reader=geoip_reader,
            session_maker=session_maker,
        )
    assert service.flush_records.await_count == 0


async def test_import_file_detects_the_format_from_a_sample_not_the_first_line(tmp_path, geoip_reader, monkeypatch):
    """A first line that only matches geo-only must not strip access logs from the rest."""
    from geometrikks.services import importer

    clf = '2.125.160.216 - frank [03/Aug/2024:13:14:17 +0200] "GET /a.gif HTTP/1.0" 200 2326'
    log = tmp_path / "old.log"
    log.write_text(clf + "\n" + make_log_line(TEST_IP) + "\n" + make_log_line(TEST_IP) + "\n")

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)

    parser = LogParser(source_label=str(log), send_logs=True)
    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
    )

    assert parser.send_logs is True
    assert result.records_written == 2
    flushed = [r for call in service.flush_records.await_args_list for r in call.args[0]]
    assert sum(1 for r in flushed if r.access_log is not None) == 2


async def test_import_file_before_drops_lines_at_or_after_the_cutoff(tmp_path, geoip_reader, monkeypatch):
    """--before keeps an import from overlapping rows a newer log already wrote."""
    from datetime import datetime, timezone

    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text("".join(make_log_line(TEST_IP, day=d) + "\n" for d in (1, 2, 3, 4)))

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)

    parser = LogParser(source_label=str(log), send_logs=True)
    # make_log_line stamps 13:14:17 +0200, so day 3's line is exactly the cutoff.
    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
        before=datetime(2024, 8, 3, 11, 14, 17, tzinfo=timezone.utc),
    )

    assert result.lines_total == 4
    assert result.lines_after_cutoff == 2
    assert result.lines_skipped == 0
    assert result.records_written == 2
    flushed = [r for call in service.flush_records.await_args_list for r in call.args[0]]
    assert len(flushed) == 2
    assert result.time_start is not None and result.time_start.day == 1
    assert result.time_end is not None and result.time_end.day == 2


async def test_import_file_before_applies_to_lines_without_geo_data(tmp_path, geoip_reader, monkeypatch):
    """A private client IP gets no geo data or access log, but its line is still dated."""
    from datetime import datetime, timezone

    from geometrikks.services import importer

    log = tmp_path / "old.log"
    log.write_text(make_log_line("10.0.0.1", day=1) + "\n" + make_log_line("10.0.0.1", day=5) + "\n")

    service, FakeRepo, session_maker = _import_deps(tmp_path)
    monkeypatch.setattr(importer, "ImportJobRepository", FakeRepo)

    parser = LogParser(source_label=str(log), send_logs=True)
    result = await importer.import_file(
        log, service=service, parser=parser, reader=geoip_reader,
        session_maker=session_maker,
        before=datetime(2024, 8, 3, tzinfo=timezone.utc),
    )

    assert result.lines_after_cutoff == 1
    flushed = [r for call in service.flush_records.await_args_list for r in call.args[0]]
    assert [r.raw_line.split("[", 1)[1][:2] for r in flushed] == ["01"]


# make_log_line stamps 13:14:17 +0200, which is 11:14:17 UTC on that day.
def _utc_day(day: int):
    from datetime import datetime, timezone

    return datetime(2024, 8, day, 11, 14, 17, tzinfo=timezone.utc)


def _deps_with_prior_job(tmp_path, prior_job):
    """Fake wiring whose repo returns prior_job and records what gets written."""
    service, FakeRepo, session_maker = _import_deps(tmp_path)
    written: dict = {}

    class PriorRepo(FakeRepo):
        async def get_by_checksum(self, checksum):
            return prior_job

        async def add(self, job, auto_commit=True):
            written["added"] = job
            return job

        async def update(self, job, auto_commit=True):
            written["updated"] = job
            return job

    return service, PriorRepo, session_maker, written


def _cutoff_log(tmp_path):
    """Days 1-4 plus one unparseable line, which carries no timestamp."""
    log = tmp_path / "old.log"
    log.write_text(
        "".join(make_log_line(TEST_IP, day=d) + "\n" for d in (1, 2, 3, 4)) + "not a log line\n"
    )
    return log


def _flushed_days(service) -> list[int]:
    return sorted(
        r.timestamp.day
        for call in service.flush_records.await_args_list
        for r in call.args[0]
        if r.timestamp is not None
    )


async def test_import_file_records_the_cutoff_on_a_new_job(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, None)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    await importer.import_file(
        log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
        reader=geoip_reader, session_maker=session_maker, before=_utc_day(3),
    )

    assert written["added"].cutoff == _utc_day(3)


@pytest.mark.parametrize(
    ("prior_cutoff_day", "before_day"),
    [
        pytest.param(3, 3, id="same-cutoff"),
        pytest.param(None, 3, id="whole-file-already-imported"),
        pytest.param(None, None, id="whole-file-imported-twice"),
    ],
)
async def test_import_file_skips_when_nothing_new_is_in_range(
    tmp_path, geoip_reader, monkeypatch, prior_cutoff_day, before_day
):
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    prior_job = MagicMock(cutoff=_utc_day(prior_cutoff_day) if prior_cutoff_day else None)
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, prior_job)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    result = await importer.import_file(
        log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
        before=_utc_day(before_day) if before_day else None,
    )

    assert result.skipped is True
    assert service.flush_records.await_count == 0
    assert written == {}


async def test_import_file_later_cutoff_imports_only_the_gap(tmp_path, geoip_reader, monkeypatch):
    """Lines before the stored cutoff, and lines with no timestamp, were written last time."""
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    prior_job = MagicMock(
        cutoff=_utc_day(2), records_written=1, lines_skipped=1,
        time_start=_utc_day(1), time_end=_utc_day(1),
    )
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, prior_job)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    result = await importer.import_file(
        log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
        reader=geoip_reader, session_maker=session_maker, before=_utc_day(4),
    )

    assert result.skipped is False
    assert _flushed_days(service) == [2, 3]
    assert sum(len(call.args[0]) for call in service.flush_records.await_args_list) == 2
    assert result.records_written == 2
    assert result.lines_already_imported == 2
    assert result.lines_after_cutoff == 1
    job = written["updated"]
    assert job.cutoff == _utc_day(4)
    assert job.records_written == 3
    assert job.lines_skipped == 1
    assert job.time_start == _utc_day(1)
    assert job.time_end == _utc_day(3)


async def test_import_file_dropping_the_cutoff_imports_the_rest(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    prior_job = MagicMock(
        cutoff=_utc_day(3), records_written=2, lines_skipped=1,
        time_start=_utc_day(1), time_end=_utc_day(2),
    )
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, prior_job)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    await importer.import_file(
        log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
        reader=geoip_reader, session_maker=session_maker,
    )

    assert _flushed_days(service) == [3, 4]
    assert written["updated"].cutoff is None
    assert written["updated"].records_written == 4


async def test_import_file_refuses_an_earlier_cutoff(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    prior_job = MagicMock(cutoff=_utc_day(3))
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, prior_job)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    with pytest.raises(importer.ImportCutoffConflictError, match="--force"):
        await importer.import_file(
            log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
            reader=geoip_reader, session_maker=session_maker, before=_utc_day(2),
        )
    assert service.flush_records.await_count == 0
    assert written == {}


async def test_import_file_force_ignores_the_stored_cutoff(tmp_path, geoip_reader, monkeypatch):
    from geometrikks.services import importer

    log = _cutoff_log(tmp_path)
    prior_job = MagicMock(cutoff=_utc_day(3))
    service, Repo, session_maker, written = _deps_with_prior_job(tmp_path, prior_job)
    monkeypatch.setattr(importer, "ImportJobRepository", Repo)

    result = await importer.import_file(
        log, service=service, parser=LogParser(source_label=str(log), send_logs=True),
        reader=geoip_reader, session_maker=session_maker, before=_utc_day(2), force=True,
    )

    assert _flushed_days(service) == [1]
    assert result.lines_already_imported == 0
    assert written["updated"].cutoff == _utc_day(2)
