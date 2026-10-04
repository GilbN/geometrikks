"""Reader reload after a GeoLite2 refresh.

Two layers: fingerprints on LogIngestionService (does the file on disk still
match what the readers opened?) and the scheduler job wrapper that refreshes
the databases and triggers the reload. The fingerprint check, rather than a
download-succeeded flag, is what also picks up files replaced out-of-band
(e.g. an external geoipupdate against a mounted file).
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.services.ingestion import LogInput
from geometrikks.services.ingestion import service as service_module
from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logsources import FileSource
from tests.test_ingestion import TEST_DB_IPS, FakeRepos, FakeSession, make_log_line, wait_until

pytestmark = pytest.mark.anyio

CITY_SRC = Path("tests/GeoLite2-City-Test.mmdb")
ASN_SRC = Path("tests/GeoLite2-ASN-Test.mmdb")
ASN_TEST_IP = "89.160.20.112"


def replace_file(src: Path, dest: Path) -> None:
    """Copy src over dest via a temp name + replace, giving dest a new inode
    exactly like the downloader's atomic tmp.replace(dest)."""
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dest)


def make_service(
    city: Path | str,
    asn: Path | str | None = None,
    inputs: list[LogInput] | None = None,
    repos: FakeRepos | None = None,
) -> LogIngestionService:
    repos = repos or FakeRepos()
    return LogIngestionService(
        inputs=inputs or [],
        session_maker=cast("Any", lambda: FakeSession(repos)),
        repos_factory=cast("Any", repos.factory),
        geoip_path=city,
        asn_db_path=asn,
        hostname="test-host",
        commit_interval=0.1,
    )


def numbered_line(n: int, ip: str = TEST_DB_IPS[0]) -> str:
    """A valid line whose URL identifies it, so a lost line and a
    duplicated one cannot cancel out in a count."""
    return make_log_line(ip).replace("/index.php", f"/line-{n}")


def urls(repos: FakeRepos) -> list[str]:
    return sorted(cast("Any", row).url for row in repos.access_log.added)


def file_input(path: Path) -> LogInput:
    return LogInput(
        source=FileSource(path, poll_interval=0.02),
        parser=LogParser(source_label=str(path), send_logs=True, hostname="test-host"),
    )


def append_line(path: Path, line: str) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


# ---------------------------------------------------------------------------
# LogIngestionService fingerprints
# ---------------------------------------------------------------------------


async def test_started_service_is_not_stale(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        assert service.readers_stale() is False
    finally:
        await service.stop()


async def test_replaced_city_db_is_stale(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        replace_file(CITY_SRC, city)
        assert service.readers_stale() is True
    finally:
        await service.stop()


async def test_replaced_asn_db_is_stale(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    asn = tmp_path / "asn.mmdb"
    shutil.copyfile(CITY_SRC, city)
    shutil.copyfile(ASN_SRC, asn)
    service = make_service(city, asn)
    await service.start(skip_validation=True)
    try:
        replace_file(ASN_SRC, asn)
        assert service.readers_stale() is True
    finally:
        await service.stop()


async def test_missing_city_db_appearing_later_is_stale(tmp_path: Path) -> None:
    """Geo-degraded recovery: start() failed to open a reader, then a usable
    file shows up (a later successful download). That must read as stale so
    the refresh job starts ingestion without a process restart."""
    city = tmp_path / "city.mmdb"
    service = make_service(city)
    await service.start(skip_validation=True)  # no file: start aborts
    assert service.is_running is False

    shutil.copyfile(CITY_SRC, city)
    assert service.readers_stale() is True


async def test_absent_asn_db_staying_absent_is_not_stale(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city, tmp_path / "never-downloaded.mmdb")
    await service.start(skip_validation=True)
    try:
        assert service.readers_stale() is False
    finally:
        await service.stop()


async def test_reload_reopens_and_clears_staleness(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        replace_file(CITY_SRC, city)
        assert service.readers_stale() is True
        await service.reload_readers()
        assert service.readers_stale() is False
    finally:
        await service.stop()


async def test_lines_written_during_a_reload_are_ingested_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A line the proxy writes while the reload opens the new database must
    not fall between the old tailer and a new one."""
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    log = tmp_path / "access.log"
    log.write_text("", encoding="utf-8")
    repos = FakeRepos()
    service = make_service(city, inputs=[file_input(log)], repos=repos)
    await service.start(skip_validation=True)
    try:
        await asyncio.sleep(0.1)  # let the tailer open the file
        append_line(log, numbered_line(1))
        await wait_until(lambda: urls(repos) == ["/line-1"])

        real_create_reader = service_module.create_reader

        def create_reader_while_traffic_arrives(*args, **kwargs):
            append_line(log, numbered_line(2))
            return real_create_reader(*args, **kwargs)

        monkeypatch.setattr(service_module, "create_reader", create_reader_while_traffic_arrives)
        replace_file(CITY_SRC, city)
        await service.reload_readers()
        monkeypatch.setattr(service_module, "create_reader", real_create_reader)

        # Long enough for a restarted tailer to have reopened the file, so
        # line 3 arrives either way and only line 2 separates the outcomes.
        await asyncio.sleep(0.2)
        append_line(log, numbered_line(3))
        await wait_until(lambda: "/line-3" in urls(repos))
        await asyncio.sleep(0.2)
        assert urls(repos) == ["/line-1", "/line-2", "/line-3"]
    finally:
        await service.stop()


async def test_running_input_is_enriched_by_the_new_readers(tmp_path: Path) -> None:
    """The input task must pick up the swapped lookups. A cached lookup
    survives a closed reader but a miss on one returns None. The ASN
    assertion on a known IP shows the ASN lookup is the new one. Line 3
    carries an IP the old City lookup never saw, so it only arrives when the
    new City lookup answers: a stale one returns None and no access-log row
    is written for that line."""
    city = tmp_path / "city.mmdb"
    asn = tmp_path / "asn.mmdb"
    shutil.copyfile(CITY_SRC, city)
    log = tmp_path / "access.log"
    log.write_text("", encoding="utf-8")
    repos = FakeRepos()
    service = make_service(city, asn, inputs=[file_input(log)], repos=repos)

    def row(n: int) -> Any:
        return next(r for r in repos.access_log.added if cast("Any", r).url == f"/line-{n}")

    await service.start(skip_validation=True)
    try:
        await asyncio.sleep(0.1)
        append_line(log, numbered_line(1, ASN_TEST_IP))
        await wait_until(lambda: "/line-1" in urls(repos))
        assert row(1).country_code is not None
        assert row(1).autonomous_system_number is None  # no ASN database yet

        shutil.copyfile(ASN_SRC, asn)
        replace_file(CITY_SRC, city)
        await service.reload_readers()

        append_line(log, numbered_line(2, ASN_TEST_IP))
        await wait_until(lambda: "/line-2" in urls(repos))
        assert row(2).country_code == row(1).country_code
        assert row(2).autonomous_system_number is not None

        append_line(log, numbered_line(3, TEST_DB_IPS[0]))
        await wait_until(lambda: "/line-3" in urls(repos))
        assert row(3).country_code is not None
    finally:
        await service.stop()


@pytest.mark.parametrize("failure", [OSError, asyncio.CancelledError])
async def test_swap_closes_both_old_readers_when_one_close_fails(
    tmp_path: Path, failure: type[BaseException]
) -> None:
    from geometrikks.services.ingestion.lookups import GeoLookups

    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        real = service._lookups
        assert real is not None
        old_city, old_asn = MagicMock(), MagicMock()
        old_city.close.side_effect = failure("close failed")
        service._lookups = GeoLookups(
            reader=old_city, asn_reader=old_asn, city=real.city, asn=None
        )
        real.reader.close()

        if failure is asyncio.CancelledError:
            with pytest.raises(asyncio.CancelledError):
                await service.reload_readers()
        else:
            await service.reload_readers()

        old_city.close.assert_called_once_with()
        old_asn.close.assert_called_once_with()
        assert service._lookups is not None and service._lookups.reader is not old_city
        assert service.is_running is True
        assert service.unexpected_stop is False
    finally:
        await service.stop()


async def test_swap_raises_a_cancellation_that_follows_an_ordinary_close_error(
    tmp_path: Path,
) -> None:
    """The City close fails with an ordinary error and the ASN close is
    cancelled: the cancellation must not be dropped in favour of the first
    failure."""
    from geometrikks.services.ingestion.lookups import GeoLookups

    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        real = service._lookups
        assert real is not None
        old_city, old_asn = MagicMock(), MagicMock()
        old_city.close.side_effect = OSError("close failed")
        old_asn.close.side_effect = asyncio.CancelledError("cancelled")
        service._lookups = GeoLookups(
            reader=old_city, asn_reader=old_asn, city=real.city, asn=None
        )
        real.reader.close()

        with pytest.raises(asyncio.CancelledError):
            await service.reload_readers()

        old_city.close.assert_called_once_with()
        old_asn.close.assert_called_once_with()
        assert service._lookups is not None and service._lookups.reader is not old_city
    finally:
        await service.stop()


async def test_reload_closes_the_old_readers_and_uses_the_new(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        old = service._lookups
        assert old is not None
        replace_file(CITY_SRC, city)
        await service.reload_readers()

        new = service._lookups
        assert new is not None and new is not old
        with pytest.raises(ValueError):
            old.reader.city(TEST_DB_IPS[0])
        assert new.city(TEST_DB_IPS[0]) is not None
    finally:
        await service.stop()


async def test_reload_keeps_the_old_readers_when_the_new_file_will_not_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        old = service._lookups
        replace_file(CITY_SRC, city)
        monkeypatch.setattr(service_module, "create_reader", lambda *_a, **_k: None)

        await service.reload_readers()

        assert service._lookups is old
        assert old is not None and old.city(TEST_DB_IPS[0]) is not None
        assert service.is_running is True
        assert service.readers_stale() is True
    finally:
        await service.stop()


async def test_reload_picks_up_an_asn_database_that_appeared(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    asn = tmp_path / "asn.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city, asn)
    await service.start(skip_validation=True)
    try:
        assert service._lookups is not None and service._lookups.asn is None
        shutil.copyfile(ASN_SRC, asn)
        assert service.readers_stale() is True

        await service.reload_readers()

        assert service._lookups.asn is not None
        assert service.readers_stale() is False
    finally:
        await service.stop()


async def test_reload_drops_an_asn_database_that_disappeared(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    asn = tmp_path / "asn.mmdb"
    shutil.copyfile(CITY_SRC, city)
    shutil.copyfile(ASN_SRC, asn)
    service = make_service(city, asn)
    await service.start(skip_validation=True)
    try:
        asn.unlink()
        await service.reload_readers()

        assert service._lookups is not None and service._lookups.asn is None
        assert service.is_running is True
    finally:
        await service.stop()


async def test_reload_leaves_source_status_alone(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    missing = tmp_path / "missing.log"
    service = make_service(city, inputs=[file_input(missing)])
    await service.start(skip_validation=True)
    try:
        await wait_until(lambda: service.missing_files == [str(missing)])
        replace_file(CITY_SRC, city)
        await service.reload_readers()
        assert service.missing_files == [str(missing)]
    finally:
        await service.stop()


async def test_reload_of_a_stopped_service_takes_the_restart_path(tmp_path: Path) -> None:
    """With is_running False the reload goes through stop() and start(), as
    it always has, and hands start() the original skip_validation."""
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    service.is_running = False

    restart = AsyncMock()
    service.start = restart  # type: ignore[method-assign]
    await service.reload_readers()
    restart.assert_awaited_once_with(skip_validation=True)


async def test_disable_reloads_makes_reload_inert(tmp_path: Path) -> None:
    """Teardown stops ingestion before the scheduler shuts down; a mid-flight
    refresh job must not resurrect the tail tasks."""
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)
    try:
        before = service._lookups
        service.disable_reloads()
        restart = AsyncMock()
        service.start = restart  # type: ignore[method-assign]
        await service.reload_readers()
        restart.assert_not_awaited()
        assert service._lookups is before
    finally:
        await service.stop()


# ---------------------------------------------------------------------------
# refresh_geoip_job wrapper
# ---------------------------------------------------------------------------


def _fake_app(service: MagicMock | None = None) -> SimpleNamespace:
    state = SimpleNamespace()
    if service is not None:
        state.ingestion_service = service
    return SimpleNamespace(state=state)


def _fake_ingestion(*, stale: bool) -> MagicMock:
    service = MagicMock()
    service.readers_stale = MagicMock(return_value=stale)
    service.reload_readers = AsyncMock()
    return service


@pytest.fixture
def refresh(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    from geometrikks.services.geoip import downloader
    from geometrikks.services.geoip.downloader import RefreshResult

    mock = AsyncMock(return_value=RefreshResult())
    monkeypatch.setattr(downloader, "refresh_geoip_databases", mock)
    return mock


async def test_job_reloads_stale_readers(refresh: AsyncMock) -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    settings = Settings()
    service = _fake_ingestion(stale=True)
    await refresh_geoip_job(settings, cast("Any", _fake_app(service)))

    # force=True: a run of this job (scheduled or the Settings Run button)
    # means "fetch a fresh copy now", not "download only if stale".
    refresh.assert_awaited_once_with(settings.geoip, force=True)
    service.reload_readers.assert_awaited_once()


async def test_job_skips_reload_when_readers_fresh(refresh: AsyncMock) -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    service = _fake_ingestion(stale=False)
    await refresh_geoip_job(Settings(), cast("Any", _fake_app(service)))

    service.reload_readers.assert_not_awaited()


async def test_job_without_ingestion_service_only_refreshes(refresh: AsyncMock) -> None:
    """A UI head (LOGPARSER_ENABLED=false) never constructs the service; the
    job must still refresh the files without raising."""
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    await refresh_geoip_job(Settings(), cast("Any", _fake_app()))

    refresh.assert_awaited_once()


async def test_job_with_app_none_degrades_to_refresh_only(refresh: AsyncMock) -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    await refresh_geoip_job(Settings(), None)

    refresh.assert_awaited_once()


async def test_job_updates_availability_flags(
    refresh: AsyncMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """/health reads these; a successful download after a degraded start must
    flip them without a restart."""
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    monkeypatch.setenv("GEOIP_DB_PATH", str(CITY_SRC))
    monkeypatch.setenv("GEOIP_ASN_ENABLED", "true")
    monkeypatch.setenv("GEOIP_ASN_DB_PATH", str(ASN_SRC))
    app = _fake_app()
    await refresh_geoip_job(Settings(), cast("Any", app))

    assert app.state.geoip_available is True
    assert app.state.asn_available is True


async def test_job_reports_unavailable_databases(
    refresh: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job

    monkeypatch.setenv("GEOIP_DB_PATH", str(tmp_path / "missing.mmdb"))
    app = _fake_app()
    await refresh_geoip_job(Settings(), cast("Any", app))

    assert app.state.geoip_available is False


async def test_job_raises_after_reloading_when_a_download_failed(
    refresh: AsyncMock,
) -> None:
    """A failed edition must reach the run tracker after readers reload."""
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import refresh_geoip_job
    from geometrikks.services.geoip.downloader import RefreshResult

    refresh.return_value = RefreshResult(city_error="City: 503")
    service = _fake_ingestion(stale=True)

    with pytest.raises(RuntimeError, match="City: 503"):
        await refresh_geoip_job(Settings(), cast("Any", _fake_app(service)))

    service.reload_readers.assert_awaited_once()


async def test_create_scheduler_wires_the_wrapper_with_app() -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler, refresh_geoip_job

    settings = Settings()
    app = cast("Any", _fake_app())
    scheduler = await create_scheduler(MagicMock(), settings, app=app)
    job = scheduler.get_job("geoip-refresh")
    assert job is not None
    assert job.func is refresh_geoip_job
    assert job.args[0] is settings
    assert job.args[1] is app
