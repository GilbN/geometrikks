"""Submit one AbuseIPDB report. The row is recorded before the call and settled after it."""
from __future__ import annotations

import contextlib
import ipaddress
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from litestar.exceptions import HTTPException

from geometrikks.domain.abuseipdb.errors import (
    RecentReportError,
    ReportingDisabledError,
    ReportUnconfirmedError,
    UpstreamFailedError,
    UpstreamRateLimitedError,
    UpstreamRejectedError,
)
from geometrikks.domain.abuseipdb.models import AbuseIpdbReport, ReporterKind
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbReportRepository
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.server.api_key_auth import ApiKeyPrincipal
from geometrikks.server.auth import AdminUser
from geometrikks.server.logging import get_logger
from geometrikks.services.abuseipdb import (
    AbuseIpdbAuthError,
    AbuseIpdbClient,
    AbuseIpdbRateLimitedError,
    AbuseIpdbRejectedError,
    AbuseIpdbUnavailableError,
)

logger = get_logger(__name__)

REPORT_INTERVAL = timedelta(minutes=15)
REPORTED_IPS_WINDOW = timedelta(days=90)
MAX_COMMENT_LENGTH = 1024
CATEGORY_IDS = frozenset(range(1, 24))


@dataclass(frozen=True)
class Reporter:
    kind: ReporterKind
    name: str | None
    api_key_id: UUID | None


@dataclass(frozen=True)
class ReportSubmission:
    ip_address: str
    categories: list[int]
    comment: str
    attack_time: datetime


def reporter_from_user(user: object) -> Reporter:
    if isinstance(user, AdminUser):
        return Reporter("user", user.username, None)
    if isinstance(user, ApiKeyPrincipal):
        return Reporter("api_key", user.name, user.key_id)
    return Reporter("anonymous", None, None)


def normalize_public_ip(value: str) -> str:
    """The canonical spelling of a globally routable address, so every spelling hits the same rows."""
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        raise DomainValidationError("ipAddress must be an IP address", code="invalid_ip") from None
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id is not None:
            raise DomainValidationError("ipAddress must not carry a zone index", code="invalid_ip")
        address = address.ipv4_mapped or address
    if not address.is_global:
        raise DomainValidationError("ipAddress must be a public IP address", code="invalid_ip")
    return str(address)


def _check_categories(categories: list[int]) -> None:
    if not categories:
        raise DomainValidationError("categories must hold at least one category")
    unknown = [category for category in categories if category not in CATEGORY_IDS]
    if unknown:
        raise DomainValidationError(f"categories holds unknown IDs {unknown}; known IDs are 1 to 23")
    if len(set(categories)) != len(categories):
        raise DomainValidationError("categories must not repeat an ID")


def _checked_comment(comment: str) -> str:
    stripped = comment.strip()
    if not 1 <= len(stripped) <= MAX_COMMENT_LENGTH:
        raise DomainValidationError(f"comment must be 1 to {MAX_COMMENT_LENGTH} characters")
    if "\x00" in stripped:
        raise DomainValidationError("comment must not contain NUL characters")
    return stripped


def _check_attack_time(attack_time: datetime, now: datetime) -> None:
    if attack_time.tzinfo is None or attack_time.utcoffset() is None:
        raise DomainValidationError("attackTime must carry a timezone")
    if attack_time > now:
        raise DomainValidationError("attackTime must not be in the future")


def _log_failure(ip: str, *, upstream_status: int | None, reason: str, error: Exception | None = None) -> None:
    # Log only the class name. SQLAlchemy error text embeds bound parameters, and the comment is one.
    fields = {} if error is None else {"error_type": type(error).__name__}
    logger.warning(
        "abuseipdb_report_failed", ip_address=ip, upstream_status=upstream_status, reason=reason, **fields
    )


async def _rollback(repository: AbuseIpdbReportRepository) -> None:
    with contextlib.suppress(Exception):
        await repository.session.rollback()


UpstreamError = AbuseIpdbRateLimitedError | AbuseIpdbRejectedError | AbuseIpdbAuthError | AbuseIpdbUnavailableError


def upstream_http_error(error: UpstreamError, *, quota: Literal["check", "report"]) -> HTTPException:
    """The HTTP error for an AbuseIPDB failure; ``quota`` names the daily limit a 429 spent."""
    if isinstance(error, AbuseIpdbRateLimitedError):
        detail = error.detail
        if error.daily and error.resets_at is not None:
            resets_at = error.resets_at.astimezone(UTC).strftime("%H:%M")
            detail = f"AbuseIPDB's daily {quota} limit is used up. It resets at {resets_at} UTC."
        return UpstreamRateLimitedError(detail, retry_after=error.retry_after)
    if isinstance(error, AbuseIpdbRejectedError):
        if error.status == 422:
            return UpstreamRejectedError(detail=error.detail)
        return UpstreamFailedError(detail=error.detail)
    if isinstance(error, AbuseIpdbAuthError):
        return UpstreamFailedError(detail="AbuseIPDB rejected ABUSEIPDB_API_KEY")
    return UpstreamFailedError(detail=error.detail)


def _clear_rejection(error: UpstreamError) -> tuple[HTTPException, int | None, str]:
    """The HTTP error, upstream status and log reason for an answer that proves AbuseIPDB recorded nothing."""
    rejection = upstream_http_error(error, quota="report")
    if isinstance(error, AbuseIpdbRateLimitedError):
        return rejection, 429, "rate_limited"
    if isinstance(error, AbuseIpdbRejectedError):
        return rejection, error.status, "rejected"
    if isinstance(error, AbuseIpdbAuthError):
        return rejection, None, "key_rejected"
    return rejection, None, "unreachable"


async def submit_report(
    submission: ReportSubmission,
    *,
    reporter: Reporter,
    repository: AbuseIpdbReportRepository,
    client: AbuseIpdbClient | None,
    reporting_enabled: bool,
    now: datetime,
) -> AbuseIpdbReport:
    """Send one report to AbuseIPDB, which publishes it, and keep a row for every report that may have landed.

    The row is committed as ``unconfirmed`` before the call. A clear acceptance
    marks it ``sent``; a clear rejection deletes it; anything else leaves it.
    """
    if not reporting_enabled or client is None:
        raise ReportingDisabledError
    ip = normalize_public_ip(submission.ip_address)
    _check_categories(submission.categories)
    comment = _checked_comment(submission.comment)
    _check_attack_time(submission.attack_time, now)

    latest = await repository.latest_reported_at(ip)
    if latest is not None and (wait := latest + REPORT_INTERVAL - now) > timedelta(0):
        raise RecentReportError(math.ceil(wait.total_seconds()))

    # Skip the refresh here too. If it failed after the commit, an unsent row would block the IP.
    # Without a reload, ip_address also stays the normalized str rather than asyncpg's ipaddress object.
    row = await repository.add(
        AbuseIpdbReport(
            ip_address=ip,
            categories=list(submission.categories),
            comment=comment,
            attack_time=submission.attack_time,
            reported_at=now,
            status="unconfirmed",
            reporter_kind=reporter.kind,
            reporter_name=reporter.name,
            api_key_id=reporter.api_key_id,
        ),
        auto_commit=True,
        auto_refresh=False,
    )
    row_id = row.id

    try:
        result = await client.report(ip, submission.categories, comment, submission.attack_time)
    except (AbuseIpdbRateLimitedError, AbuseIpdbRejectedError, AbuseIpdbAuthError, AbuseIpdbUnavailableError) as error:
        if isinstance(error, AbuseIpdbUnavailableError) and error.maybe_sent:
            _log_failure(ip, upstream_status=None, reason="unconfirmed")
            raise ReportUnconfirmedError from error
        rejection, upstream_status, reason = _clear_rejection(error)
        try:
            await repository.delete(row_id, auto_commit=True)
        except Exception as cleanup_error:
            await _rollback(repository)
            _log_failure(ip, upstream_status=upstream_status, reason="cleanup_failed", error=cleanup_error)
        else:
            _log_failure(ip, upstream_status=upstream_status, reason=reason)
        raise rejection from error

    row.status = "sent"
    row.abuse_confidence_score = result.abuse_confidence_score
    row.reported_at = now
    try:
        # Skip the refresh. If it failed after the commit, a sent row would be reported as unconfirmed.
        row = await repository.update(row, auto_commit=True, auto_refresh=False)
    # AbuseIPDB has published the report by now. Any failure here must read as unconfirmed,
    # never as a 500 or a rejection, because the committed unconfirmed row is its only record.
    except Exception as error:
        await _rollback(repository)
        _log_failure(ip, upstream_status=None, reason="settle_failed", error=error)
        raise ReportUnconfirmedError from error

    logger.info(
        "abuseipdb_report_sent",
        ip_address=ip,
        categories=list(submission.categories),
        score=result.abuse_confidence_score,
        reporter_kind=reporter.kind,
        comment_length=len(comment),
    )
    return row
