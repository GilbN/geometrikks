"""AbuseIPDB client: request shape, caching, rate limits and error mapping."""
from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx2
import pytest
from pydantic import SecretStr

from geometrikks.config.settings import AbuseIpdbSettings
from geometrikks.lib.outbound import USER_AGENT
from geometrikks.services import abuseipdb
from geometrikks.services.abuseipdb import (
    MAX_RESPONSE_BYTES,
    AbuseIpdbAuthError,
    AbuseIpdbClient,
    AbuseIpdbError,
    AbuseIpdbRateLimitedError,
    AbuseIpdbRejectedError,
    AbuseIpdbUnavailableError,
    RateLimit,
    ReportResult,
    get_abuseipdb_client,
)

pytestmark = pytest.mark.anyio

RESET = 1762560000
CHECK_BODY = {
    "data": {
        "ipAddress": "3.5.140.2",
        "isPublic": True,
        "abuseConfidenceScore": 52,
        "countryCode": "US",
        "usageType": "Data Center/Web Hosting/Transit",
        "isp": "Amazon",
        "domain": "amazon.com",
        "isTor": False,
        "isWhitelisted": None,
        "totalReports": 12,
        "numDistinctUsers": 5,
        "lastReportedAt": "2026-11-06T14:02:00+00:00",
    }
}
REPORT_BODY = {"data": {"ipAddress": "3.5.140.2", "abuseConfidenceScore": 52}}
REPORTED_AT = datetime(2026, 11, 6, 14, 2, tzinfo=UTC)


def build_client(
    response: httpx2.Response | Exception,
    clock=None,
) -> tuple[AbuseIpdbClient, list[httpx2.Request]]:
    calls: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        calls.append(request)
        if isinstance(response, Exception):
            raise response
        return response

    kwargs = {"clock": clock} if clock else {}
    client = AbuseIpdbClient(api_key="test-key", timeout=5, transport=httpx2.MockTransport(handler), **kwargs)
    return client, calls


async def test_report_sends_form_fields_and_headers():
    client, calls = build_client(httpx2.Response(200, json=REPORT_BODY))

    result = await client.report("3.5.140.2", [21, 19], "probing", REPORTED_AT)

    assert result == ReportResult(ip_address="3.5.140.2", abuse_confidence_score=52)
    request = calls[0]
    assert request.method == "POST" and str(request.url) == "https://api.abuseipdb.com/api/v2/report"
    assert request.headers["Key"] == "test-key"
    assert request.headers["Accept"] == "application/json"
    assert request.headers["User-Agent"] == USER_AGENT
    assert parse_qs(request.content.decode()) == {
        "ip": ["3.5.140.2"],
        "categories": ["21,19"],
        "comment": ["probing"],
        "timestamp": ["2026-11-06T14:02:00+00:00"],
    }


async def test_check_parses_and_caches_for_15_minutes():
    now = [1000.0]
    client, calls = build_client(httpx2.Response(200, json=CHECK_BODY), clock=lambda: now[0])

    first = await client.check("3.5.140.2")
    now[0] += 900
    second = await client.check("3.5.140.2")
    assert len(calls) == 1
    assert second == first
    assert first.abuse_confidence_score == 52
    assert first.total_reports == 12
    assert first.num_distinct_users == 5
    assert first.last_reported_at == REPORTED_AT
    assert first.usage_type == "Data Center/Web Hosting/Transit"
    assert (first.isp, first.domain, first.country_code) == ("Amazon", "amazon.com", "US")
    assert first.is_tor is False and first.is_whitelisted is None
    request = calls[0]
    assert request.method == "GET" and request.url.params["ipAddress"] == "3.5.140.2"
    assert request.headers["Key"] == "test-key"

    now[0] += 1
    await client.check("3.5.140.2")
    assert len(calls) == 2


async def test_rate_limit_headers_are_remembered_per_endpoint():
    client, _ = build_client(
        httpx2.Response(
            200,
            json=REPORT_BODY,
            headers={
                "X-RateLimit-Limit": "1000",
                "X-RateLimit-Remaining": "986",
                "X-RateLimit-Reset": str(RESET),
            },
        )
    )

    await client.report("3.5.140.2", [21], "probing", REPORTED_AT)

    assert client.rate_limit("report") == RateLimit(1000, 986, datetime.fromtimestamp(RESET, UTC))
    assert client.rate_limit("check") is None


@pytest.mark.parametrize("status", [401, 403])
async def test_bad_key_is_an_auth_error(status):
    client, _ = build_client(httpx2.Response(status, json={"errors": [{"detail": "Bad key", "status": status}]}))

    with pytest.raises(AbuseIpdbAuthError) as exc:
        await client.check("3.5.140.2")
    assert exc.value.detail == "Bad key"


async def test_422_carries_the_upstream_detail():
    detail = "The ip address must be a valid IPv4 or IPv6 address."
    client, _ = build_client(httpx2.Response(422, json={"errors": [{"detail": detail, "status": 422}]}))

    with pytest.raises(AbuseIpdbRejectedError) as exc:
        await client.report("nope", [21], "probing", REPORTED_AT)
    assert exc.value.detail == detail
    assert exc.value.status == 422


async def test_repeat_report_429_is_not_daily():
    client, _ = build_client(
        httpx2.Response(
            429,
            json={"errors": [{"detail": "Too many requests for this IP", "status": 429}]},
            headers={"Retry-After": "840", "X-RateLimit-Remaining": "900"},
        )
    )

    with pytest.raises(AbuseIpdbRateLimitedError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert (exc.value.retry_after, exc.value.daily) == (840, False)


async def test_daily_limit_429_is_daily():
    client, _ = build_client(
        httpx2.Response(
            429,
            json={"errors": [{"detail": "Daily rate limit exceeded", "status": 429}]},
            headers={"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(RESET)},
        )
    )

    with pytest.raises(AbuseIpdbRateLimitedError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert exc.value.daily is True
    assert exc.value.resets_at == datetime.fromtimestamp(RESET, UTC)
    assert client.rate_limit("report") == RateLimit(1000, 0, datetime.fromtimestamp(RESET, UTC))


@pytest.mark.parametrize(
    ("raised", "maybe_sent"),
    [
        (httpx2.ConnectError("refused"), False),
        (httpx2.ConnectTimeout("slow"), False),
        (httpx2.PoolTimeout("busy"), False),
        (httpx2.ReadTimeout("slow"), True),
        (httpx2.RemoteProtocolError("cut"), True),
    ],
)
async def test_transport_failures_say_whether_the_report_may_have_left(raised, maybe_sent):
    client, _ = build_client(raised)

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert exc.value.maybe_sent is maybe_sent


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(503),
        httpx2.Response(200, content=b"<html>"),
        httpx2.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1)),
        httpx2.Response(200, json={"data": {"ipAddress": "3.5.140.2"}}),
        httpx2.Response(200, json={"data": {"ipAddress": None, "abuseConfidenceScore": True}}),
    ],
    ids=["5xx", "not-json", "oversized", "wrong-shape", "wrong-types"],
)
async def test_5xx_and_unparseable_and_oversized_answers_may_have_been_sent(response):
    client, _ = build_client(response)

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert exc.value.maybe_sent is True


async def test_redirects_are_not_followed():
    client, calls = build_client(httpx2.Response(302, headers={"Location": "https://example.com/"}))

    with pytest.raises(AbuseIpdbUnavailableError) as report_exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert report_exc.value.maybe_sent is True
    with pytest.raises(AbuseIpdbUnavailableError) as check_exc:
        await client.check("3.5.140.2")
    assert check_exc.value.maybe_sent is False
    assert [str(call.url.host) for call in calls] == ["api.abuseipdb.com", "api.abuseipdb.com"]


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(401, json={"errors": [{"detail": "Bad key", "status": 401}]}),
        httpx2.Response(422, json={"errors": [{"detail": "Bad ip", "status": 422}]}),
        httpx2.Response(429, headers={"Retry-After": "5"}),
        httpx2.Response(503),
        httpx2.Response(302, headers={"Location": "https://example.com/"}),
        httpx2.ReadTimeout("slow"),
        httpx2.ConnectError("refused"),
    ],
)
async def test_errors_never_contain_the_key(response):
    client, _ = build_client(response)

    with pytest.raises(AbuseIpdbError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert "test-key" not in str(exc.value)
    assert "test-key" not in exc.value.detail


def test_no_key_means_no_client():
    assert get_abuseipdb_client(AbuseIpdbSettings(api_key=None)) is None


def test_client_is_shared_until_the_key_or_timeout_changes():
    settings = AbuseIpdbSettings(api_key=SecretStr("key-a"), request_timeout=5)

    first = get_abuseipdb_client(settings)
    assert first is not None and get_abuseipdb_client(settings) is first
    assert abuseipdb._client is first

    rekeyed = get_abuseipdb_client(AbuseIpdbSettings(api_key=SecretStr("key-b"), request_timeout=5))
    assert rekeyed is not first
    slower = get_abuseipdb_client(AbuseIpdbSettings(api_key=SecretStr("key-b"), request_timeout=9))
    assert slower is not rekeyed


async def test_default_transport_guard_blocks_real_requests():
    client = AbuseIpdbClient(api_key="test-key", timeout=5)

    with pytest.raises(pytest.fail.Exception, match="tried to reach AbuseIPDB"):
        await client.check("3.5.140.2")


async def test_check_answer_problems_never_say_maybe_sent():
    for response in (httpx2.Response(503), httpx2.Response(200, content=b"<html>")):
        client, _ = build_client(response)
        with pytest.raises(AbuseIpdbUnavailableError) as exc:
            await client.check("3.5.140.2")
        assert exc.value.maybe_sent is False


async def test_check_rejects_wrongly_typed_fields():
    bad = {"data": {**CHECK_BODY["data"], "totalReports": True}}
    client, _ = build_client(httpx2.Response(200, json=bad))

    with pytest.raises(AbuseIpdbUnavailableError):
        await client.check("3.5.140.2")


async def test_upstream_detail_containing_the_key_is_redacted():
    client, _ = build_client(
        httpx2.Response(401, json={"errors": [{"detail": "Key test-key is invalid", "status": 401}]})
    )

    with pytest.raises(AbuseIpdbAuthError) as exc:
        await client.check("3.5.140.2")
    assert exc.value.detail == "Key [redacted] is invalid"
    assert "test-key" not in str(exc.value)


class _BrokenBody(httpx2.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"errors":'
        raise httpx2.ReadError("cut")


async def test_oversized_429_body_still_classifies_and_records_the_quota():
    client, _ = build_client(
        httpx2.Response(
            429,
            content=b"x" * (MAX_RESPONSE_BYTES + 1),
            headers={"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(RESET)},
        )
    )

    with pytest.raises(AbuseIpdbRateLimitedError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert exc.value.daily is True
    assert exc.value.detail == "AbuseIPDB answered 429"
    assert client.rate_limit("report") == RateLimit(1000, 0, datetime.fromtimestamp(RESET, UTC))


async def test_interrupted_401_body_is_still_an_auth_error():
    client, _ = build_client(httpx2.Response(401, stream=_BrokenBody()))

    with pytest.raises(AbuseIpdbAuthError) as exc:
        await client.check("3.5.140.2")
    assert exc.value.detail == "AbuseIPDB answered 401"


async def test_naive_timestamp_is_refused():
    client, calls = build_client(httpx2.Response(200, json=REPORT_BODY))

    with pytest.raises(ValueError, match="timezone-aware"):
        await client.report("3.5.140.2", [21], "probing", datetime(2026, 11, 6, 14, 2))
    assert calls == []
