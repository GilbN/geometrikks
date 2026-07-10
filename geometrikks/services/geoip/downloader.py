"""GeoLite2-City auto-download from MaxMind.

Startup + weekly-scheduler entry point is ensure_geoip_database(): it never
raises — geo enrichment is optional and the app must come up without it.
The license key is used for HTTP Basic auth and never logged.
"""

from __future__ import annotations

import logging
import tarfile
import tempfile
import time
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from geometrikks.config.settings import GeoIPSettings

logger = logging.getLogger(__name__)

DOWNLOAD_URL = "https://download.maxmind.com/geoip/databases/GeoLite2-City/download"


class GeoIPDownloadError(Exception):
    """Download or extraction failed."""


def has_credentials(settings: "GeoIPSettings") -> bool:
    return bool(settings.account_id and settings.license_key)


def database_is_stale(db_path: Path, max_age_days: int) -> bool:
    """Missing or older than max_age_days."""
    if not db_path.exists():
        return True
    age_seconds = time.time() - db_path.stat().st_mtime
    return age_seconds > max_age_days * 86400


async def _fetch_tarball(settings: "GeoIPSettings") -> bytes:
    """GET the tar.gz with basic auth; module-level for test monkeypatching."""
    try:
        async with httpx.AsyncClient(
            auth=(settings.account_id or "", settings.license_key or ""),
            timeout=120.0,
            follow_redirects=True,
        ) as client:
            response = await client.get(DOWNLOAD_URL, params={"suffix": "tar.gz"})
            response.raise_for_status()
            return response.content
    except httpx.HTTPError as exc:
        raise GeoIPDownloadError(f"MaxMind download failed: {exc}") from exc


def _extract_mmdb(tarball: bytes, dest: Path) -> None:
    """Pull the single .mmdb member out and atomically replace dest."""
    try:
        with tarfile.open(fileobj=BytesIO(tarball), mode="r:gz") as tar:
            member = next(
                (m for m in tar.getmembers() if m.name.endswith(".mmdb")), None
            )
            if member is None:
                raise GeoIPDownloadError("no .mmdb member in MaxMind tarball")
            extracted = tar.extractfile(member)
            if extracted is None:
                raise GeoIPDownloadError("could not read .mmdb member")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=dest.parent, suffix=".tmp", delete=False
                ) as tmp:
                    tmp.write(extracted.read())
                    tmp_path = Path(tmp.name)
                tmp_path.replace(dest)  # atomic on same filesystem
            except BaseException:
                # don't litter the geoip volume with .tmp files on failed runs
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)
                raise
    except tarfile.TarError as exc:
        raise GeoIPDownloadError(f"invalid tarball: {exc}") from exc


async def download_database(settings: "GeoIPSettings") -> Path:
    """Download + extract; raises GeoIPDownloadError."""
    logger.info("Downloading GeoLite2-City from MaxMind...")
    tarball = await _fetch_tarball(settings)
    _extract_mmdb(tarball, settings.db_path)
    logger.info("GeoLite2-City updated: %s", settings.db_path)
    return settings.db_path


async def ensure_geoip_database(settings: "GeoIPSettings") -> bool:
    """Make the mmdb present-and-fresh if possible. Returns usability.

    - fresh db, no creds        -> True (nothing to do)
    - stale/missing db, creds   -> try download; True if a db exists after
    - missing db, no creds      -> False + actionable warning (degraded mode)
    """
    if not database_is_stale(settings.db_path, settings.refresh_days):
        return True

    if not has_credentials(settings):
        if settings.db_path.exists():
            logger.warning(
                "GeoLite2 database is older than %d days and no MaxMind "
                "credentials are configured; keeping the stale copy. "
                "(GeoLite2 EULA requires refreshing within 30 days.)",
                settings.refresh_days,
            )
            return True
        logger.warning(
            "No GeoLite2 database at %s and no MaxMind credentials configured. "
            "Set MAXMINDDB_USER_ID and MAXMINDDB_LICENSE_KEY (free account: "
            "https://www.maxmind.com/en/geolite2/signup) to enable geo lookups. "
            "Starting in geo-degraded mode.",
            settings.db_path,
        )
        return False

    try:
        await download_database(settings)
        return True
    except GeoIPDownloadError as exc:
        logger.error("GeoIP download failed: %s", exc)
        return settings.db_path.exists()
    except Exception:
        # Startup/scheduler entry point: a full volume, bad mount permissions,
        # or a truncated stream must degrade, never crash the app.
        logger.exception("Unexpected error while refreshing the GeoLite2 database")
        return settings.db_path.exists()
