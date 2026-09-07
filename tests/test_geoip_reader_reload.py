"""Reader reload after a GeoLite2 refresh.

Two layers: fingerprints on LogIngestionService (does the file on disk still
match what the readers opened?) and the scheduler job wrapper that refreshes
the databases and triggers the reload. The fingerprint check, rather than a
download-succeeded flag, is what also picks up files replaced out-of-band
(e.g. an external geoipupdate against a mounted file).
"""
from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.services.ingestion.service import LogIngestionService

pytestmark = pytest.mark.anyio

CITY_SRC = Path("tests/GeoLite2-City-Test.mmdb")
ASN_SRC = Path("tests/GeoLite2-ASN-Test.mmdb")


def replace_file(src: Path, dest: Path) -> None:
    """Copy src over dest via a temp name + replace, giving dest a new inode
    exactly like the downloader's atomic tmp.replace(dest)."""
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dest)


def make_service(
    city: Path | str, asn: Path | str | None = None
) -> LogIngestionService:
    return LogIngestionService(
        parsers=[],
        session_maker=cast("Any", None),
        geoip_path=city,
        asn_db_path=asn,
        hostname="test-host",
    )


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


async def test_reload_reuses_the_original_skip_validation(tmp_path: Path) -> None:
    city = tmp_path / "city.mmdb"
    shutil.copyfile(CITY_SRC, city)
    service = make_service(city)
    await service.start(skip_validation=True)

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
        service.disable_reloads()
        restart = AsyncMock()
        service.start = restart  # type: ignore[method-assign]
        await service.reload_readers()
        restart.assert_not_awaited()
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
