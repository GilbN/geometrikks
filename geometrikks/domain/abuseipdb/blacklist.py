"""Keep the local copy of AbuseIPDB's blacklist current, and stop showing it once it is too old."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Literal

from geometrikks.domain.abuseipdb.repositories import AbuseIpdbBlacklistRepository
from geometrikks.server.logging import get_logger
from geometrikks.services.abuseipdb import AbuseIpdbError, AbuseIpdbRateLimitedError, AbuseIpdbRejectedError

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.services.abuseipdb import AbuseIpdbClient

logger = get_logger(__name__)

MIN_ATTEMPT_INTERVAL = timedelta(hours=5)
MAX_LIST_AGE = timedelta(hours=72)


@dataclass(frozen=True)
class BlacklistOutcome:
    status: Literal["refreshed", "skipped", "failed"]
    count: int | None
    reason: str | None


@dataclass(frozen=True)
class BlacklistView:
    generated_at: datetime | None
    refreshed_at: datetime | None
    ips: list[str]


def _repository(session: AsyncSession) -> AbuseIpdbBlacklistRepository:
    return AbuseIpdbBlacklistRepository(session=session, wrap_exceptions=False)


def _upstream_status(error: AbuseIpdbError) -> int | None:
    if isinstance(error, AbuseIpdbRateLimitedError):
        return 429
    if isinstance(error, AbuseIpdbRejectedError):
        return error.status
    return None


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
        and status.refreshed_at > now - timedelta(hours=refresh_hours)
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


_expiry_logged_for: datetime | None = None
EMPTY_VIEW = BlacklistView(generated_at=None, refreshed_at=None, ips=[])


def _log_expiry_once(refreshed_at: datetime) -> None:
    global _expiry_logged_for
    if refreshed_at == _expiry_logged_for:
        return
    _expiry_logged_for = refreshed_at
    logger.warning("abuseipdb_blacklist_expired", refreshed_at=refreshed_at.isoformat())


async def current_blacklist(
    repository: AbuseIpdbBlacklistRepository, *, enabled: bool, now: datetime
) -> BlacklistView:
    """The list to show. AbuseIPDB requires an imported list to be kept updated or flushed, so a stale one reads empty."""
    if not enabled:
        return EMPTY_VIEW
    status = await repository.status()
    if status is None or status.refreshed_at is None:
        return EMPTY_VIEW
    if now - status.refreshed_at > MAX_LIST_AGE:
        _log_expiry_once(status.refreshed_at)
        return EMPTY_VIEW
    return BlacklistView(generated_at=status.generated_at, refreshed_at=status.refreshed_at, ips=await repository.ips())
