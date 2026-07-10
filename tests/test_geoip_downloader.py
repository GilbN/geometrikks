"""GeoIP auto-download: staleness, credential gating, atomic replace."""
from __future__ import annotations

import io
import tarfile
import time
from pathlib import Path

import pytest

from geometrikks.config.settings import GeoIPSettings


@pytest.fixture(autouse=True)
def no_local_maxmind_credentials(monkeypatch):
    """Local MaxMind credentials (env or .env) must not leak into these tests."""
    for var in ("MAXMINDDB_USER_ID", "MAXMINDDB_LICENSE_KEY", "GEOIP_REFRESH_DAYS"):
        monkeypatch.delenv(var, raising=False)


def make_settings(tmp_path: Path, **kwargs) -> GeoIPSettings:
    return GeoIPSettings(
        db_path=tmp_path / "GeoLite2-City.mmdb",
        validate_db_path=False,
        _env_file=None,
        **kwargs,
    )


def make_tarball(mmdb_bytes: bytes) -> bytes:
    """A MaxMind-shaped tar.gz: GeoLite2-City_20260701/GeoLite2-City.mmdb."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("GeoLite2-City_20260701/GeoLite2-City.mmdb")
        info.size = len(mmdb_bytes)
        tar.addfile(info, io.BytesIO(mmdb_bytes))
    return buf.getvalue()


class TestStaleness:
    def test_missing_file_is_stale(self, tmp_path):
        from geometrikks.services.geoip.downloader import database_is_stale
        assert database_is_stale(tmp_path / "nope.mmdb", max_age_days=7) is True

    def test_fresh_file_is_not_stale(self, tmp_path):
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")
        assert database_is_stale(p, max_age_days=7) is False

    def test_old_file_is_stale(self, tmp_path):
        import os
        from geometrikks.services.geoip.downloader import database_is_stale
        p = tmp_path / "db.mmdb"
        p.write_bytes(b"x")
        old = time.time() - 8 * 86400
        os.utime(p, (old, old))
        assert database_is_stale(p, max_age_days=7) is True


class TestEnsure:
    async def test_no_credentials_no_db_returns_false(self, tmp_path, caplog):
        from geometrikks.services.geoip.downloader import ensure_geoip_database
        settings = make_settings(tmp_path)
        with caplog.at_level("WARNING"):
            ok = await ensure_geoip_database(settings)
        assert ok is False
        assert any("MAXMINDDB_USER_ID" in r.message for r in caplog.records)

    async def test_no_credentials_existing_db_returns_true(self, tmp_path):
        from geometrikks.services.geoip.downloader import ensure_geoip_database
        settings = make_settings(tmp_path)
        settings.db_path.write_bytes(b"existing")
        assert await ensure_geoip_database(settings) is True

    async def test_download_extracts_and_replaces_atomically(self, tmp_path, monkeypatch):
        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        tarball = make_tarball(b"MMDB-CONTENT")

        async def fake_fetch(s):
            return tarball

        monkeypatch.setattr(downloader, "_fetch_tarball", fake_fetch)

        ok = await downloader.ensure_geoip_database(settings)
        assert ok is True
        assert settings.db_path.read_bytes() == b"MMDB-CONTENT"
        # no temp litter
        assert list(settings.db_path.parent.glob("*.tmp")) == []

    async def test_failed_download_keeps_existing_db_and_returns_true(self, tmp_path, monkeypatch):
        import os
        from geometrikks.services.geoip import downloader

        settings = make_settings(tmp_path, account_id="1", license_key="k")
        settings.db_path.write_bytes(b"OLD")
        old = time.time() - 30 * 86400
        os.utime(settings.db_path, (old, old))  # stale -> download attempted

        async def boom(s):
            raise downloader.GeoIPDownloadError("http 401")

        monkeypatch.setattr(downloader, "_fetch_tarball", boom)

        ok = await downloader.ensure_geoip_database(settings)
        assert ok is True, "existing (stale) db still usable after failed refresh"
        assert settings.db_path.read_bytes() == b"OLD"
