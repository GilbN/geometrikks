"""Keep the local copy of AbuseIPDB's blacklist current, and stop showing it once it is too old."""
from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Literal

import msgspec

from geometrikks.config.settings import get_installed_version
from geometrikks.domain.abuseipdb import blacklist_file
from geometrikks.domain.abuseipdb.blacklist_file import BlacklistFileError
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbBlacklistRepository
from geometrikks.domain.abuseipdb.schemas import (
    AbuseIpdbBlacklistAboutView,
    AbuseIpdbBlacklistResponse,
)
from geometrikks.server.logging import get_logger
from geometrikks.services.abuseipdb import (
    AbuseIpdbError,
    AbuseIpdbRateLimitedError,
    AbuseIpdbRejectedError,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.domain.abuseipdb.models import AbuseIpdbBlacklistStatus
    from geometrikks.services.abuseipdb import AbuseIpdbClient

logger = get_logger(__name__)

MIN_ATTEMPT_INTERVAL = timedelta(hours=5)
MAX_LIST_AGE = timedelta(hours=72)
RUNNING_ATTEMPT_GRACE = timedelta(minutes=2)


@dataclass(frozen=True)
class BlacklistOutcome:
    status: Literal["refreshed", "skipped", "failed"]
    count: int | None
    reason: str | None


@dataclass(frozen=True)
class CurrentBlacklist:
    etag: str
    body: bytes | None


def _repository(session: AsyncSession) -> AbuseIpdbBlacklistRepository:
    return AbuseIpdbBlacklistRepository(session=session, wrap_exceptions=False)


def _upstream_status(error: AbuseIpdbError) -> int | None:
    if isinstance(error, AbuseIpdbRateLimitedError):
        return 429
    if isinstance(error, AbuseIpdbRejectedError):
        return error.status
    return None


def _listed_at(refreshed_at: datetime, generated_at: datetime | None) -> datetime:
    """The time the list's age counts from. A file can hold a list generated long before it was written."""
    return min(refreshed_at, generated_at or refreshed_at)


def _expired(refreshed_at: datetime, generated_at: datetime | None, *, now: datetime) -> bool:
    return now - _listed_at(refreshed_at, generated_at) > MAX_LIST_AGE


def _skipped(reason: str) -> BlacklistOutcome:
    logger.info("abuseipdb_blacklist_refresh_skipped", reason=reason)
    return BlacklistOutcome("skipped", None, reason)


async def refresh_blacklist(
    session_factory: Callable[[], AsyncSession],
    client: AbuseIpdbClient,
    *,
    now: datetime,
    startup: bool = False,
    refresh_hours: int = 24,
) -> BlacklistOutcome:
    """Download the blacklist if due and swap it in. A failure leaves the previous list in place."""
    try:
        return await _refresh(session_factory, client, now=now, startup=startup, refresh_hours=refresh_hours)
    except AbuseIpdbError as error:
        reason = error.detail
        upstream_status = _upstream_status(error)
    # Log only the class name. SQLAlchemy error text embeds bound parameters, and here those are the list.
    except Exception as error:
        reason = f"unexpected error: {type(error).__name__}"
        upstream_status = None
    logger.warning("abuseipdb_blacklist_refresh_failed", reason=reason, upstream_status=upstream_status)
    return BlacklistOutcome("failed", None, reason)


async def _refresh(
    session_factory: Callable[[], AsyncSession],
    client: AbuseIpdbClient,
    *,
    now: datetime,
    startup: bool,
    refresh_hours: int,
) -> BlacklistOutcome:
    async with session_factory() as session:
        status = await _repository(session).status()
    if (
        startup
        and status is not None
        and status.refreshed_at is not None
        and _listed_at(status.refreshed_at, status.generated_at) > now - timedelta(hours=refresh_hours)
    ):
        return _skipped("fresh")

    # Committed before the request, so a download that dies midway still counts against the daily calls.
    async with session_factory() as session, session.begin():
        claimed = await _repository(session).claim_attempt(now, last_allowed=now - MIN_ATTEMPT_INTERVAL)
    if not claimed:
        return _skipped("attempted less than 5 hours ago")

    blacklist = await client.blacklist()
    async with session_factory() as session, session.begin():
        await _repository(session).replace(blacklist.ips, generated_at=blacklist.generated_at, refreshed_at=now)
    logger.info("abuseipdb_blacklist_refreshed", count=len(blacklist.ips))
    return BlacklistOutcome("refreshed", len(blacklist.ips), None)


async def refresh_blacklist_file(
    session_factory: Callable[[], AsyncSession], path: Path, *, now: datetime
) -> BlacklistOutcome:
    """Swap in the file's list if it was written since the last read. A failure keeps the previous list."""
    try:
        return await _refresh_from_file(session_factory, path, now=now)
    except BlacklistFileError as error:
        reason = error.detail
    # Log only the class name. SQLAlchemy error text embeds bound parameters, and here those are the list.
    except Exception as error:
        reason = f"unexpected error: {type(error).__name__}"
    logger.warning("abuseipdb_blacklist_refresh_failed", reason=reason, upstream_status=None, path=str(path))
    return BlacklistOutcome("failed", None, reason)


async def _refresh_from_file(
    session_factory: Callable[[], AsyncSession], path: Path, *, now: datetime
) -> BlacklistOutcome:
    modified_at = await blacklist_file.blacklist_file_modified_at(path, now=now)
    async with session_factory() as session:
        status = await _repository(session).status()
    if status is not None and status.refreshed_at == modified_at:
        return BlacklistOutcome("skipped", None, "unchanged")

    modified_at, body = await blacklist_file.read_blacklist_file(path, now=now)
    blacklist = await asyncio.to_thread(blacklist_file.parse_blacklist_file, body, modified_at=modified_at)
    ips = blacklist.ips
    if len(ips) > blacklist_file.MAX_FILE_IPS:
        logger.warning(
            "abuseipdb_blacklist_file_truncated", count=len(ips), kept=blacklist_file.MAX_FILE_IPS, path=str(path)
        )
        ips = ips[: blacklist_file.MAX_FILE_IPS]
    async with session_factory() as session, session.begin():
        await _repository(session).replace(ips, generated_at=blacklist.generated_at, refreshed_at=modified_at)
    logger.info("abuseipdb_blacklist_refreshed", count=len(ips), path=str(path))
    return BlacklistOutcome("refreshed", len(ips), None)


_expiry_logged_for: datetime | None = None
EMPTY_BLACKLIST_BODY = msgspec.json.encode(AbuseIpdbBlacklistResponse(generated_at=None, refreshed_at=None, ips=[]))
_APP_VERSION = get_installed_version()

_body_key: tuple[datetime, datetime | None] | None = None
_body = b""
_body_lock = asyncio.Lock()


def reset_blacklist_body() -> None:
    global _body_key, _body, _body_lock
    _body_key = None
    _body = b""
    _body_lock = asyncio.Lock()


def _forget_body() -> None:
    global _body_key, _body
    _body_key = None
    _body = b""


def _log_expiry_once(refreshed_at: datetime, generated_at: datetime | None) -> None:
    global _expiry_logged_for
    if refreshed_at == _expiry_logged_for:
        return
    _expiry_logged_for = refreshed_at
    logger.warning(
        "abuseipdb_blacklist_expired",
        refreshed_at=refreshed_at.isoformat(),
        generated_at=generated_at.isoformat() if generated_at else None,
    )


def _etag(refreshed_at: datetime, generated_at: datetime | None) -> str:
    # The app version is in the tag, so a browser cannot revalidate an answer an older release encoded.
    version_text = f"{_APP_VERSION}|{refreshed_at.isoformat()}|{generated_at.isoformat() if generated_at else ''}"
    return f'W/"{hashlib.blake2b(version_text.encode(), digest_size=8).hexdigest()}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Weak comparison, as If-None-Match uses."""
    if if_none_match is None:
        return False
    tags = {tag.strip().removeprefix("W/") for tag in if_none_match.split(",")}
    return "*" in tags or etag.removeprefix("W/") in tags


async def _encoded_body(
    repository: AbuseIpdbBlacklistRepository, refreshed_at: datetime, generated_at: datetime | None
) -> bytes:
    global _body_key, _body
    async with _body_lock:
        if _body_key != (refreshed_at, generated_at):
            ips = await repository.ips()
            _body = msgspec.json.encode(
                AbuseIpdbBlacklistResponse(generated_at=generated_at, refreshed_at=refreshed_at, ips=ips)
            )
            _body_key = (refreshed_at, generated_at)
        return _body


async def current_blacklist(
    repository: AbuseIpdbBlacklistRepository, *, enabled: bool, now: datetime, if_none_match: str | None = None
) -> CurrentBlacklist | None:
    """The list to show, or None while it is empty.

    AbuseIPDB requires an imported list to be kept updated or flushed, so a stale one reads empty. The process
    keeps the encoded answer until the stored list changes. ``body`` is None when ``if_none_match`` names it.
    """
    if not enabled:
        _forget_body()
        return None
    status = await repository.status()
    if status is None or status.refreshed_at is None:
        _forget_body()
        return None
    if _expired(status.refreshed_at, status.generated_at, now=now):
        _log_expiry_once(status.refreshed_at, status.generated_at)
        _forget_body()
        return None
    etag = _etag(status.refreshed_at, status.generated_at)
    if etag_matches(if_none_match, etag):
        return CurrentBlacklist(etag=etag, body=None)
    return CurrentBlacklist(etag=etag, body=await _encoded_body(repository, status.refreshed_at, status.generated_at))


def _last_attempt_failed(status: AbuseIpdbBlacklistStatus, *, from_file: bool, now: datetime) -> bool:
    # A good download stores refreshed_at equal to the attempt's start, so a later attempt stored nothing.
    # _refresh claims the attempt before the request, so a recent one may still be downloading.
    if from_file or status.last_attempt_at is None or status.last_attempt_at > now - RUNNING_ATTEMPT_GRACE:
        return False
    return status.refreshed_at is None or status.last_attempt_at > status.refreshed_at


async def blacklist_about(
    repository: AbuseIpdbBlacklistRepository, *, file_path: Path | None, now: datetime
) -> AbuseIpdbBlacklistAboutView:
    """How current the stored list is, for Settings > About."""
    status = await repository.status()
    from_file = file_path is not None
    refreshed_at = status.refreshed_at if status else None
    generated_at = status.generated_at if status else None
    return AbuseIpdbBlacklistAboutView(
        source="file" if from_file else "download",
        file_path=str(file_path) if file_path is not None else None,
        ip_count=await repository.count(),
        generated_at=generated_at,
        refreshed_at=refreshed_at,
        last_attempt_at=None if from_file or status is None else status.last_attempt_at,
        last_attempt_failed=status is not None and _last_attempt_failed(status, from_file=from_file, now=now),
        expired=refreshed_at is not None and _expired(refreshed_at, generated_at, now=now),
    )
