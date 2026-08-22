"""GeoIP auto-download: staleness, credential gating, atomic replace."""
from __future__ import annotations

import io
import tarfile
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from geometrikks.config.settings import GeoIPSettings

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def no_local_maxmind_credentials(monkeypatch):
    """Local MaxMind credentials (env or .env) must not leak into these tests."""
    for var in ("MAXMINDDB_USER_ID", "MAXMINDDB_LICENSE_KEY", "GEOIP_REFRESH_DAYS"):
        monkeypatch.delenv(var, raising=False)


def make_settings(tmp_path: Path, **kwargs) -> GeoIPSettings:
    return GeoIPSettings(
        db_path=tmp_path / "GeoLite2-City.mmdb",
        asn_db_path=tmp_path / "GeoLite2-ASN.mmdb",
        validate_db_path=False,
        _env_file=None,
        **kwargs,
    )


class TestAsnSettings:
    def test_defaults(self):
        s = GeoIPSettings(_env_file=None)
        assert s.asn_enabled is True
        assert s.asn_db_path.is_absolute()
        assert s.asn_db_path.name == "GeoLite2-ASN.mmdb"

    def test_relative_asn_path_resolves_from_project_root(self):
        s = GeoIPSettings(asn_db_path=Path("data/geoip/custom-asn.mmdb"), _env_file=None)
        assert s.asn_db_path.is_absolute()
        assert str(s.asn_db_path).endswith("data/geoip/custom-asn.mmdb")


def make_tarball(mmdb_bytes: bytes) -> bytes:
    """A MaxMind-shaped tar.gz: GeoLite2-City_20260701/GeoLite2-City.mmdb."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("GeoLite2-City_20260701/GeoLite2-City.mmdb")
        info.size = len(mmdb_bytes)
        tar.addfile(info, io.BytesIO(mmdb_bytes))
    return buf.getvalue()


class FakeMMDBReader:
    """Stands in for maxminddb.open_database; only metadata().build_epoch is read."""

    def __init__(self, build_epoch: float):
        self._metadata = SimpleNamespace(build_epoch=build_epoch)

    def metadata(self):
        return self._metadata

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def patch_build_epoch(monkeypatch, age_days: float) -> None:
    """Make maxminddb report a database built age_days ago, regardless of file."""
    epoch = time.time() - age_days * 86400
    monkeypatch.setattr(
        "geometrikks.lib.utils.maxminddb.open_database",
        lambda _path: FakeMMDBReader(epoch),
    )


class TestStaleness:
    def test_missing_file_is_stale(self, tmp_path):
        from geometrikks.services.geoip.downloader import database_is_stale
        assert database_is_stale(tmp_path / "nope.mmdb", max_age_days=7) is True

    def test_unreadable_file_is_stale(self, tmp_path):
        """Not a valid mmdb -> no build date to trust -> stale."""
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")
        assert database_is_stale(p, max_age_days=7) is True

    def test_fresh_build_date_is_not_stale(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")
        patch_build_epoch(monkeypatch, age_days=1)
        assert database_is_stale(p, max_age_days=7) is False

    def test_old_build_date_is_stale_despite_fresh_mtime(
        self, tmp_path, monkeypatch, caplog
    ):
        """The bug this check replaced: mtime is fresh (file just written) but
        the database itself was built 8 days ago -> stale, with a warning."""
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")  # mtime = now
        patch_build_epoch(monkeypatch, age_days=8)
        with caplog.at_level("WARNING"):
            assert database_is_stale(p, max_age_days=7) is True
        assert any("older than 7 days" in r.message for r in caplog.records)

    def test_build_date_at_max_age_is_not_stale(self, tmp_path, monkeypatch):
        """Staleness is strictly greater-than: exactly max_age_days is kept."""
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")
        patch_build_epoch(monkeypatch, age_days=7)
        assert database_is_stale(p, max_age_days=7) is False


class TestEnsure:
    async def test_no_credentials_no_db_returns_false(self, tmp_path, caplog):
        from geometrikks.services.geoip.downloader import ensure_geoip_database
        settings = make_settings(tmp_path)
        with caplog.at_level("WARNING"):
            ok = await ensure_geoip_database(settings)
        assert ok is False
        assert any("MAXMINDDB_USER_ID" in r.message for r in caplog.records)

    async def test_no_credentials_fresh_db_returns_true(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip.downloader import ensure_geoip_database
        settings = make_settings(tmp_path)
        settings.db_path.write_bytes(b"existing")
        patch_build_epoch(monkeypatch, age_days=1)
        assert await ensure_geoip_database(settings) is True

    async def test_no_credentials_stale_db_keeps_copy_and_returns_true(
        self, tmp_path, caplog
    ):
        """Unreadable/old db without credentials: keep it, warn, stay usable."""
        from geometrikks.services.geoip.downloader import ensure_geoip_database
        settings = make_settings(tmp_path)
        settings.db_path.write_bytes(b"existing")  # not a valid mmdb -> stale
        with caplog.at_level("WARNING"):
            assert await ensure_geoip_database(settings) is True
        assert any("keeping the stale copy" in r.message for r in caplog.records)

    async def test_download_extracts_and_replaces_atomically(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        tarball = make_tarball(b"MMDB-CONTENT")

        async def fake_fetch(s, edition):
            return tarball

        monkeypatch.setattr(downloader, "_fetch_tarball", fake_fetch)

        ok = await downloader.ensure_geoip_database(settings)
        assert ok is True
        assert settings.db_path.read_bytes() == b"MMDB-CONTENT"
        # no temp litter
        assert list(settings.db_path.parent.glob("*.tmp")) == []

    async def test_os_error_during_extraction_degrades_without_litter(self, tmp_path, monkeypatch):
        """ensure_geoip_database never raises — an OSError from the filesystem
        (full volume, bad mount permissions) degrades and leaves no .tmp files."""
        from pathlib import Path as PathCls

        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        tarball = make_tarball(b"MMDB-CONTENT")

        async def fake_fetch(s, edition):
            return tarball

        def broken_replace(self, target):
            raise OSError("read-only file system")

        monkeypatch.setattr(downloader, "_fetch_tarball", fake_fetch)
        monkeypatch.setattr(PathCls, "replace", broken_replace)

        ok = await downloader.ensure_geoip_database(settings)
        assert ok is False, "no db could be written -> degraded"
        assert list(settings.db_path.parent.glob("*.tmp")) == []

    async def test_failed_download_keeps_readable_stale_db_and_returns_true(
        self, tmp_path, monkeypatch
    ):
        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        settings.db_path.write_bytes(b"OLD")
        patch_build_epoch(monkeypatch, age_days=30)  # readable but stale -> download attempted

        async def boom(s, edition):
            raise downloader.GeoIPDownloadError("http 401")

        monkeypatch.setattr(downloader, "_fetch_tarball", boom)

        ok = await downloader.ensure_geoip_database(settings)
        assert ok is True, "existing (stale) db still usable after failed refresh"
        assert settings.db_path.read_bytes() == b"OLD"

    async def test_failed_download_with_unreadable_file_returns_false(self, tmp_path, monkeypatch):
        """A file that exists but is not an mmdb must not be reported as usable:
        ingestion cannot open it, and a True here would silence the advisory."""
        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        settings.db_path.write_bytes(b"not an mmdb")

        async def boom(s, edition):
            raise downloader.GeoIPDownloadError("http 401")

        monkeypatch.setattr(downloader, "_fetch_tarball", boom)
        assert await downloader.ensure_geoip_database(settings) is False


class TestAsnEnsure:
    async def test_disabled_returns_false_without_touching_network(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        called = False

        async def fake_fetch(settings, edition):
            nonlocal called
            called = True
            return b""

        monkeypatch.setattr(downloader, "_fetch_tarball", fake_fetch)
        settings = make_settings(tmp_path, asn_enabled=False)
        assert await downloader.ensure_asn_database(settings) is False
        assert called is False

    async def test_missing_db_no_creds_returns_false(self, tmp_path):
        from geometrikks.services.geoip.downloader import ensure_asn_database
        settings = make_settings(tmp_path)
        assert await ensure_asn_database(settings) is False

    async def test_downloads_asn_edition_to_asn_path(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        seen_editions: list[str] = []

        async def fake_fetch(settings, edition):
            seen_editions.append(edition)
            return make_tarball(b"asn-bytes")

        monkeypatch.setattr(downloader, "_fetch_tarball", fake_fetch)
        settings = make_settings(tmp_path, account_id="123", license_key="key")
        assert await downloader.ensure_asn_database(settings) is True
        assert seen_editions == [downloader.ASN_EDITION]
        assert settings.asn_db_path.read_bytes() == b"asn-bytes"
        assert not settings.db_path.exists()

    async def test_stale_without_creds_keeps_existing_copy(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip.downloader import ensure_asn_database
        settings = make_settings(tmp_path)
        settings.asn_db_path.write_bytes(b"old")
        patch_build_epoch(monkeypatch, age_days=30)
        assert await ensure_asn_database(settings) is True

    async def test_download_failure_reports_readability_not_existence(
        self, tmp_path, monkeypatch
    ):
        from geometrikks.services.geoip import downloader

        async def failing_fetch(settings, edition):
            raise downloader.GeoIPDownloadError("boom")

        monkeypatch.setattr(downloader, "_fetch_tarball", failing_fetch)
        settings = make_settings(tmp_path, account_id="123", license_key="key")
        assert await downloader.ensure_asn_database(settings) is False
        # Present but not an mmdb: still unusable.
        settings.asn_db_path.write_bytes(b"present")
        assert await downloader.ensure_asn_database(settings) is False
        # Readable and merely stale: usable.
        patch_build_epoch(monkeypatch, age_days=30)
        assert await downloader.ensure_asn_database(settings) is True


class TestRefreshBothEditions:
    async def test_refresh_calls_city_and_asn(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        calls: list[str] = []

        async def fake_city(settings):
            calls.append("city")
            return True

        async def fake_asn(settings):
            calls.append("asn")
            return True

        monkeypatch.setattr(downloader, "ensure_geoip_database", fake_city)
        monkeypatch.setattr(downloader, "ensure_asn_database", fake_asn)
        await downloader.refresh_geoip_databases(make_settings(tmp_path))
        assert calls == ["city", "asn"]

    async def test_refresh_skips_asn_when_disabled(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        calls: list[str] = []

        async def fake_city(settings):
            calls.append("city")
            return True

        async def fake_asn(settings):
            calls.append("asn")
            return True

        monkeypatch.setattr(downloader, "ensure_geoip_database", fake_city)
        monkeypatch.setattr(downloader, "ensure_asn_database", fake_asn)
        await downloader.refresh_geoip_databases(
            make_settings(tmp_path, asn_enabled=False)
        )
        assert calls == ["city"]
