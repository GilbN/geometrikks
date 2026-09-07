"""GeoLite2 auto-download from MaxMind (City + ASN editions).

Startup entry points are ensure_geoip_database() (City) and
ensure_asn_database(); the weekly scheduler runs refresh_geoip_databases(),
which covers both. None of them ever raise: geo enrichment is optional and
the app must come up without it. The license key is used for HTTP Basic
auth and never logged.
"""

from __future__ import annotations

import tarfile
import tempfile
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING

import httpx2

from geometrikks.lib.utils import GeoIPInfoView, geoip_info
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from geometrikks.config.settings import GeoIPSettings

logger = get_logger(__name__)

DOWNLOAD_URL_TEMPLATE = "https://download.maxmind.com/geoip/databases/{edition}/download"
CITY_EDITION = "GeoLite2-City"
ASN_EDITION = "GeoLite2-ASN"


class GeoIPDownloadError(Exception):
    """Download or extraction failed."""


@dataclass
class RefreshResult:
    """Download failures from a City and ASN refresh attempt."""

    city_error: str | None = None
    asn_error: str | None = None

    @property
    def errors(self) -> list[str]:
        """Return present errors in refresh order."""
        return [
            error
            for error in (self.city_error, self.asn_error)
            if error is not None
        ]


def has_credentials(settings: "GeoIPSettings") -> bool:
    # SecretStr("") is truthy, so the key must be unwrapped before testing.
    return bool(
        settings.account_id
        and settings.license_key
        and settings.license_key.get_secret_value()
    )


def database_is_stale(db_path: Path, max_age_days: int) -> bool:
    """Missing or older than max_age_days."""
    geoip_info_view: GeoIPInfoView = geoip_info(db_path)
    if not geoip_info_view.available:
        return True
    if geoip_info_view.age_days is None:
        return True
    stale: bool = geoip_info_view.age_days > max_age_days
    if stale:
        logger.warning(
            "GeoLite2 database at %s is older than %d days (age: %s days)",
            db_path,
            max_age_days,
            geoip_info_view.age_days,
        )
    return stale



async def _fetch_tarball(settings: "GeoIPSettings", edition: str) -> bytes:
    """GET the tar.gz with basic auth; module-level for test monkeypatching."""
    try:
        async with httpx2.AsyncClient(
            auth=(
                settings.account_id or "",
                settings.license_key.get_secret_value() if settings.license_key else "",
            ),
            timeout=120.0,
            follow_redirects=True,
        ) as client:
            response = await client.get(
                DOWNLOAD_URL_TEMPLATE.format(edition=edition),
                params={"suffix": "tar.gz"},
            )
            response.raise_for_status()
            return response.content
    except httpx2.HTTPError as exc:
        raise GeoIPDownloadError(f"MaxMind download failed ({edition}): {exc}") from exc


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


async def download_database(
    settings: "GeoIPSettings", *, edition: str, db_path: Path
) -> Path:
    """Download + extract one edition; raises GeoIPDownloadError."""
    logger.info("Downloading %s from MaxMind...", edition)
    tarball = await _fetch_tarball(settings, edition)
    _extract_mmdb(tarball, db_path)
    logger.success(  # ty: ignore[unresolved-attribute]
        "geoip_database_refreshed", edition=edition, path=str(db_path)
    )
    return db_path


async def ensure_geoip_database(
    settings: "GeoIPSettings",
    *,
    force: bool = False,
    errors: list[str] | None = None,
) -> bool:
    """Make the mmdb present-and-fresh if possible. Returns usability.

    - fresh db, no creds        -> True (nothing to do)
    - stale/missing db, creds   -> try download; True if a db exists after
    - missing db, no creds      -> False + actionable warning (degraded mode)

    force=True skips the staleness gate (the geoip-refresh job, where a run
    means "fetch a fresh copy now"); the credentials gate still applies.
    """
    if not force and not database_is_stale(settings.db_path, settings.refresh_days):
        return True

    if not has_credentials(settings):
        if geoip_info(settings.db_path).available:
            if database_is_stale(settings.db_path, settings.refresh_days):
                logger.warning(
                    "GeoLite2 database is older than %d days and no MaxMind "
                    "credentials are configured; keeping the stale copy. "
                    "(GeoLite2 EULA requires refreshing within 30 days.)",
                    settings.refresh_days,
                )
            else:
                logger.warning(
                    "GeoLite2 refresh requested but no MaxMind credentials "
                    "are configured; keeping the current database."
                )
            return True
        logger.warning(
            "No usable GeoLite2 database at %s and no MaxMind credentials configured. "
            "Set MAXMINDDB_USER_ID and MAXMINDDB_LICENSE_KEY (free account: "
            "https://www.maxmind.com/en/geolite2/signup) to enable geo lookups. "
            "Starting in geo-degraded mode.",
            settings.db_path,
        )
        return False

    try:
        await download_database(
            settings, edition=CITY_EDITION, db_path=settings.db_path
        )
        return True
    except GeoIPDownloadError as exc:
        logger.error("geoip_city_download_failed", error=str(exc))
        if errors is not None:
            errors.append(f"City: {exc}")
        return geoip_info(settings.db_path).available
    except Exception as exc:
        # Startup/scheduler entry point: a full volume, bad mount permissions,
        # or a truncated stream must degrade, never crash the app.
        logger.exception("geoip_city_refresh_failed", error=str(exc))
        if errors is not None:
            errors.append(f"City: {exc}")
        return geoip_info(settings.db_path).available


async def ensure_asn_database(
    settings: "GeoIPSettings",
    *,
    force: bool = False,
    errors: list[str] | None = None,
) -> bool:
    """Download or refresh the GeoLite2-ASN mmdb when possible; never raises.

    Unlike ensure_geoip_database, False is not degraded mode, only
    ingestion without ASN data. Disabled returns False without touching the
    network. force=True skips the staleness gate, matching
    ensure_geoip_database.
    """
    if not settings.asn_enabled:
        return False
    if not force and not database_is_stale(settings.asn_db_path, settings.refresh_days):
        return True

    if not has_credentials(settings):
        if geoip_info(settings.asn_db_path).available:
            if database_is_stale(settings.asn_db_path, settings.refresh_days):
                logger.warning(
                    "GeoLite2-ASN database is older than %d days and no MaxMind "
                    "credentials are configured; keeping the stale copy.",
                    settings.refresh_days,
                )
            else:
                logger.warning(
                    "GeoLite2-ASN refresh requested but no MaxMind credentials "
                    "are configured; keeping the current database."
                )
            return True
        logger.warning(
            "No usable GeoLite2-ASN database at %s and no MaxMind credentials "
            "configured; ASN enrichment is unavailable. Set "
            "GEOIP_ASN_ENABLED=false to silence this.",
            settings.asn_db_path,
        )
        return False

    try:
        await download_database(
            settings, edition=ASN_EDITION, db_path=settings.asn_db_path
        )
        return True
    except GeoIPDownloadError as exc:
        logger.error("geoip_asn_download_failed", error=str(exc))
        if errors is not None:
            errors.append(f"ASN: {exc}")
        return geoip_info(settings.asn_db_path).available
    except Exception as exc:
        logger.exception("geoip_asn_refresh_failed", error=str(exc))
        if errors is not None:
            errors.append(f"ASN: {exc}")
        return geoip_info(settings.asn_db_path).available


async def refresh_geoip_databases(
    settings: "GeoIPSettings", *, force: bool = False
) -> RefreshResult:
    """Scheduler entry point: refresh City always, ASN when enabled.

    Looked up through the module (not captured references) so tests can
    monkeypatch the ensure functions.
    """
    from geometrikks.services.geoip import downloader as _self

    city_errors: list[str] = []
    asn_errors: list[str] = []
    await _self.ensure_geoip_database(settings, force=force, errors=city_errors)
    if settings.asn_enabled:
        await _self.ensure_asn_database(settings, force=force, errors=asn_errors)
    return RefreshResult(
        city_error=city_errors[0] if city_errors else None,
        asn_error=asn_errors[0] if asn_errors else None,
    )
