"""AbuseIPDB API client for IP checks and abuse reports.

A check sends the queried IP to api.abuseipdb.com. A report sends the IP, the
categories, the comment and the attack timestamp, which AbuseIPDB publishes.
The API key travels only in the ``Key`` header and appears in no error text.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import httpx2
import msgspec

from geometrikks.config.settings import AbuseIpdbSettings
from geometrikks.lib.outbound import USER_AGENT
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

API_BASE = "https://api.abuseipdb.com/api/v2/"
MAX_RESPONSE_BYTES = 256 * 1024
CHECK_CACHE_TTL_SECONDS = 15 * 60
CHECK_CACHE_SIZE = 512

Endpoint = Literal["check", "report"]


class AbuseIpdbError(Exception):
    """Base for every failure talking to AbuseIPDB."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class AbuseIpdbAuthError(AbuseIpdbError):
    """AbuseIPDB refused the API key (401 or 403)."""


class AbuseIpdbRejectedError(AbuseIpdbError):
    """AbuseIPDB rejected the request (a 4xx other than 429)."""

    def __init__(self, detail: str, status: int) -> None:
        super().__init__(detail)
        self.status = status


class AbuseIpdbRateLimitedError(AbuseIpdbError):
    """AbuseIPDB answered 429; ``daily`` means the daily quota is spent."""

    def __init__(self, detail: str, *, retry_after: int | None, daily: bool, resets_at: datetime | None) -> None:
        super().__init__(detail)
        self.retry_after = retry_after
        self.daily = daily
        self.resets_at = resets_at


class AbuseIpdbUnavailableError(AbuseIpdbError):
    """AbuseIPDB could not be reached or answered something unusable.

    ``maybe_sent`` is true when the request may have reached AbuseIPDB.
    """

    def __init__(self, detail: str, *, maybe_sent: bool) -> None:
        super().__init__(detail)
        self.maybe_sent = maybe_sent


@dataclass(frozen=True)
class RateLimit:
    limit: int
    remaining: int
    resets_at: datetime | None


@dataclass(frozen=True)
class CheckResult:
    ip_address: str
    abuse_confidence_score: int
    total_reports: int
    num_distinct_users: int
    last_reported_at: datetime | None
    usage_type: str | None
    isp: str | None
    domain: str | None
    is_tor: bool
    is_whitelisted: bool | None
    country_code: str | None


@dataclass(frozen=True)
class ReportResult:
    ip_address: str
    abuse_confidence_score: int


def default_transport() -> httpx2.AsyncBaseTransport | None:
    """None selects httpx2's real transport; the test guard replaces this."""
    return None


def _int_header(headers: httpx2.Headers, name: str) -> int | None:
    try:
        return int(headers[name])
    except (KeyError, ValueError):
        return None


def _epoch_header(headers: httpx2.Headers, name: str) -> datetime | None:
    seconds = _int_header(headers, name)
    if seconds is None:
        return None
    try:
        return datetime.fromtimestamp(seconds, UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _error_detail(body: bytes, status: int) -> str:
    try:
        errors = msgspec.json.decode(body)["errors"]
        detail = errors[0]["detail"]
        if isinstance(detail, str) and detail:
            return detail
    except (msgspec.DecodeError, KeyError, IndexError, TypeError):
        pass
    return f"AbuseIPDB answered {status}"


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


class AbuseIpdbClient:
    """One httpx2 client is opened per call, so there is nothing to close."""

    def __init__(
        self,
        *,
        api_key: str,
        timeout: float,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.api_key = api_key
        self.timeout = timeout
        self._transport = transport
        self._clock = clock
        self._rate_limits: dict[Endpoint, RateLimit] = {}
        self._checks: OrderedDict[str, tuple[float, CheckResult]] = OrderedDict()

    def rate_limit(self, endpoint: Endpoint) -> RateLimit | None:
        """The quota AbuseIPDB reported on its latest answer for ``endpoint``."""
        return self._rate_limits.get(endpoint)

    def _remember_rate_limit(self, endpoint: Endpoint, headers: httpx2.Headers) -> None:
        limit = _int_header(headers, "X-RateLimit-Limit")
        remaining = _int_header(headers, "X-RateLimit-Remaining")
        if limit is None or remaining is None:
            return
        self._rate_limits[endpoint] = RateLimit(limit, remaining, _epoch_header(headers, "X-RateLimit-Reset"))

    async def _request(self, endpoint: Endpoint, method: str, form: dict[str, str]) -> dict[str, Any]:
        """Send one request and return the ``data`` object of a 2xx answer."""
        maybe_sent = endpoint == "report"
        headers = {"Key": self.api_key, "Accept": "application/json", "User-Agent": USER_AGENT}
        url = API_BASE + endpoint
        body = bytearray()
        try:
            async with httpx2.AsyncClient(
                timeout=self.timeout,
                follow_redirects=False,
                headers=headers,
                transport=self._transport or default_transport(),
            ) as client:
                request_args: dict[str, Any] = {"data": form} if method == "POST" else {"params": form}
                async with client.stream(method, url, **request_args) as resp:
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise AbuseIpdbUnavailableError("AbuseIPDB sent an oversized answer", maybe_sent=True)
        except (httpx2.ConnectError, httpx2.ConnectTimeout, httpx2.PoolTimeout) as exc:
            raise AbuseIpdbUnavailableError(f"Could not reach AbuseIPDB ({type(exc).__name__})", maybe_sent=False) from exc
        except httpx2.HTTPError as exc:
            raise AbuseIpdbUnavailableError(f"AbuseIPDB request failed ({type(exc).__name__})", maybe_sent=True) from exc

        status = resp.status_code
        self._remember_rate_limit(endpoint, resp.headers)
        if status == 429:
            raise AbuseIpdbRateLimitedError(
                _error_detail(bytes(body), status),
                retry_after=_int_header(resp.headers, "Retry-After"),
                daily=resp.headers.get("X-RateLimit-Remaining") == "0",
                resets_at=_epoch_header(resp.headers, "X-RateLimit-Reset"),
            )
        if status in (401, 403):
            raise AbuseIpdbAuthError(_error_detail(bytes(body), status))
        if 400 <= status < 500:
            raise AbuseIpdbRejectedError(_error_detail(bytes(body), status), status)
        if status >= 500 or not 200 <= status < 300:
            raise AbuseIpdbUnavailableError(f"AbuseIPDB answered {status}", maybe_sent=maybe_sent or status >= 500)
        try:
            data = msgspec.json.decode(bytes(body))["data"]
        except (msgspec.DecodeError, KeyError, TypeError) as exc:
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=True) from exc
        if not isinstance(data, dict):
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=True)
        return data

    def _cached_check(self, ip: str) -> CheckResult | None:
        hit = self._checks.get(ip)
        if hit is None:
            return None
        if self._clock() - hit[0] > CHECK_CACHE_TTL_SECONDS:
            del self._checks[ip]
            return None
        self._checks.move_to_end(ip)
        return hit[1]

    def _store_check(self, ip: str, result: CheckResult) -> None:
        self._checks[ip] = (self._clock(), result)
        self._checks.move_to_end(ip)
        while len(self._checks) > CHECK_CACHE_SIZE:
            self._checks.popitem(last=False)

    async def check(self, ip: str) -> CheckResult:
        """What AbuseIPDB knows about ``ip``; answers are cached for 15 minutes."""
        if (hit := self._cached_check(ip)) is not None:
            return hit
        data = await self._request("check", "GET", {"ip": ip})
        try:
            last_reported = data.get("lastReportedAt")
            result = CheckResult(
                ip_address=str(data["ipAddress"]),
                abuse_confidence_score=int(data["abuseConfidenceScore"]),
                total_reports=int(data["totalReports"]),
                num_distinct_users=int(data["numDistinctUsers"]),
                last_reported_at=datetime.fromisoformat(last_reported) if isinstance(last_reported, str) else None,
                usage_type=_optional_str(data.get("usageType")),
                isp=_optional_str(data.get("isp")),
                domain=_optional_str(data.get("domain")),
                is_tor=bool(data.get("isTor", False)),
                is_whitelisted=data["isWhitelisted"] if isinstance(data.get("isWhitelisted"), bool) else None,
                country_code=_optional_str(data.get("countryCode")),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=False) from exc
        self._store_check(ip, result)
        logger.info("abuseipdb_check", ip=ip, score=result.abuse_confidence_score)
        return result

    async def report(self, ip: str, categories: Sequence[int], comment: str, timestamp: datetime) -> ReportResult:
        """Report ``ip``; the comment and categories become public on AbuseIPDB."""
        data = await self._request(
            "report",
            "POST",
            {
                "ip": ip,
                "categories": ",".join(str(category) for category in categories),
                "comment": comment,
                "timestamp": timestamp.isoformat(),
            },
        )
        try:
            result = ReportResult(str(data["ipAddress"]), int(data["abuseConfidenceScore"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=True) from exc
        logger.info("abuseipdb_report", ip=ip, categories=list(categories), score=result.abuse_confidence_score)
        return result


_client: AbuseIpdbClient | None = None


def get_abuseipdb_client(settings: AbuseIpdbSettings) -> AbuseIpdbClient | None:
    """The process-wide client so its check cache and quota are shared.

    ``None`` without a key. A changed key or timeout rebuilds the client.
    """
    global _client
    if settings.api_key is None:
        return None
    api_key = settings.api_key.get_secret_value()
    if _client is None or _client.api_key != api_key or _client.timeout != settings.request_timeout:
        _client = AbuseIpdbClient(api_key=api_key, timeout=settings.request_timeout)
    return _client


def reset_abuseipdb_client() -> None:
    global _client
    _client = None
