"""AbuseIPDB API client for IP checks and abuse reports.

A check sends the queried IP to api.abuseipdb.com. A report sends the IP, the
categories, the comment and the attack timestamp, which AbuseIPDB publishes.
A blacklist download sends only the key. The API key travels only in the ``Key`` header and appears in no error text.
"""
from __future__ import annotations

import ipaddress
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
MAX_BLACKLIST_RESPONSE_BYTES = 4 * 1024 * 1024
BLACKLIST_LIMIT = 10_000
CHECK_CACHE_TTL_SECONDS = 15 * 60
CHECK_CACHE_SIZE = 512

Endpoint = Literal["check", "report", "blacklist"]


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


@dataclass(frozen=True)
class BlacklistResult:
    generated_at: datetime
    ips: list[str]


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


class _BadPayloadError(Exception):
    """A 2xx answer whose data object has missing or wrongly typed fields."""


def _required_int(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise _BadPayloadError(key)
    return value


def _required_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise _BadPayloadError(key)
    return value


def _optional(data: dict[str, Any], key: str, kind: type) -> Any:
    value = data.get(key)
    if value is not None and not isinstance(value, kind):
        raise _BadPayloadError(key)
    return value


def _canonical_global_ip(value: str) -> str | None:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id is not None:
            return None
        address = address.ipv4_mapped or address
    return str(address) if address.is_global else None


def _blacklist_entry_ip(entry: object) -> str | None:
    if not isinstance(entry, dict):
        raise _BadPayloadError("data")
    return _canonical_global_ip(_required_str(entry, "ipAddress"))


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

    async def _request_body(
        self, endpoint: Endpoint, method: str, form: dict[str, str], *, max_bytes: int = MAX_RESPONSE_BYTES
    ) -> bytes:
        """Send one request and return the body of a 2xx answer."""
        maybe_sent = endpoint == "report"
        headers = {"Key": self.api_key, "Accept": "application/json", "User-Agent": USER_AGENT}
        url = API_BASE + endpoint
        body = bytearray()
        body_problem: str | None = None
        try:
            async with httpx2.AsyncClient(
                timeout=self.timeout,
                follow_redirects=False,
                headers=headers,
                transport=self._transport or default_transport(),
            ) as client:
                request_args: dict[str, Any] = {"data": form} if method == "POST" else {"params": form}
                async with client.stream(method, url, **request_args) as resp:
                    status = resp.status_code
                    response_headers = resp.headers
                    self._remember_rate_limit(endpoint, response_headers)
                    try:
                        async for chunk in resp.aiter_bytes():
                            body += chunk
                            if len(body) > max_bytes:
                                body_problem = "sent an oversized answer"
                                break
                    except httpx2.HTTPError:
                        body_problem = "broke off its answer"
        except (httpx2.ConnectError, httpx2.ConnectTimeout, httpx2.PoolTimeout) as exc:
            raise AbuseIpdbUnavailableError(
                f"Could not reach AbuseIPDB ({type(exc).__name__})", maybe_sent=False
            ) from None
        # httpx2's error text can quote the Key header, and the exception logger prints causes, so drop the cause.
        except httpx2.HTTPError as exc:
            raise AbuseIpdbUnavailableError(
                f"AbuseIPDB request failed ({type(exc).__name__})", maybe_sent=maybe_sent
            ) from None

        if 400 <= status < 500:
            detail = f"AbuseIPDB answered {status}" if body_problem else _error_detail(bytes(body), status)
            detail = detail.replace(self.api_key, "[redacted]")
            if status == 429:
                raise AbuseIpdbRateLimitedError(
                    detail,
                    retry_after=_int_header(response_headers, "Retry-After"),
                    daily=_int_header(response_headers, "X-RateLimit-Remaining") == 0,
                    resets_at=_epoch_header(response_headers, "X-RateLimit-Reset"),
                )
            if status in (401, 403):
                raise AbuseIpdbAuthError(detail)
            raise AbuseIpdbRejectedError(detail, status)
        if body_problem:
            raise AbuseIpdbUnavailableError(f"AbuseIPDB {body_problem}", maybe_sent=maybe_sent)
        if not 200 <= status < 300:
            raise AbuseIpdbUnavailableError(f"AbuseIPDB answered {status}", maybe_sent=maybe_sent)
        return bytes(body)

    async def _request(self, endpoint: Endpoint, method: str, form: dict[str, str]) -> dict[str, Any]:
        """Send one request and return the ``data`` object of a 2xx answer."""
        maybe_sent = endpoint == "report"
        body = await self._request_body(endpoint, method, form)
        try:
            data = msgspec.json.decode(body)["data"]
        except (msgspec.DecodeError, KeyError, TypeError):
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=maybe_sent) from None
        if not isinstance(data, dict):
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=maybe_sent)
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
        data = await self._request("check", "GET", {"ipAddress": ip})
        try:
            last_reported = _optional(data, "lastReportedAt", str)
            result = CheckResult(
                ip_address=_required_str(data, "ipAddress"),
                abuse_confidence_score=_required_int(data, "abuseConfidenceScore"),
                total_reports=_required_int(data, "totalReports"),
                num_distinct_users=_required_int(data, "numDistinctUsers"),
                last_reported_at=datetime.fromisoformat(last_reported) if last_reported else None,
                usage_type=_optional(data, "usageType", str),
                isp=_optional(data, "isp", str),
                domain=_optional(data, "domain", str),
                is_tor=_optional(data, "isTor", bool) or False,
                is_whitelisted=_optional(data, "isWhitelisted", bool),
                country_code=_optional(data, "countryCode", str),
            )
        # fromisoformat quotes the upstream value, and the exception logger prints causes.
        except (_BadPayloadError, ValueError):
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=False) from None
        self._store_check(ip, result)
        logger.info("abuseipdb_check_fetched", ip_address=ip, score=result.abuse_confidence_score)
        return result

    async def report(self, ip: str, categories: Sequence[int], comment: str, timestamp: datetime) -> ReportResult:
        """Report ``ip``; the comment and categories become public on AbuseIPDB."""
        if timestamp.tzinfo is None:
            raise ValueError("timestamp must be timezone-aware")
        data = await self._request(
            "report",
            "POST",
            {
                "ip": ip,
                "categories": ",".join(str(category) for category in categories),
                "comment": comment,
                "timestamp": timestamp.isoformat(timespec="seconds"),
            },
        )
        try:
            result = ReportResult(_required_str(data, "ipAddress"), _required_int(data, "abuseConfidenceScore"))
        except _BadPayloadError:
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=True) from None
        logger.info(
            "abuseipdb_report_upstream", ip_address=ip, categories=list(categories), score=result.abuse_confidence_score
        )
        return result

    async def blacklist(self) -> BlacklistResult:
        """AbuseIPDB's blacklist, keeping only canonical global addresses. An empty list counts as unreadable."""
        body = await self._request_body(
            "blacklist", "GET", {"limit": str(BLACKLIST_LIMIT)}, max_bytes=MAX_BLACKLIST_RESPONSE_BYTES
        )
        try:
            payload = msgspec.json.decode(body)
            generated_at = datetime.fromisoformat(payload["meta"]["generatedAt"])
            if generated_at.tzinfo is None:
                raise _BadPayloadError("generatedAt")
            entries = payload["data"]
            if not isinstance(entries, list):
                raise _BadPayloadError("data")
            ips = [ip for entry in entries if (ip := _blacklist_entry_ip(entry)) is not None]
        # fromisoformat quotes the upstream value, and the exception logger prints causes.
        except (msgspec.DecodeError, _BadPayloadError, KeyError, TypeError, ValueError):
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an unreadable answer", maybe_sent=False) from None
        if not ips:
            raise AbuseIpdbUnavailableError("AbuseIPDB sent an empty blacklist", maybe_sent=False)
        return BlacklistResult(generated_at=generated_at, ips=list(dict.fromkeys(ips)))


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
