"""AbuseIPDB client: request shape, caching, rate limits and error mapping."""
from __future__ import annotations

import traceback
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
    BlacklistResult,
    MAX_BLACKLIST_RESPONSE_BYTES,
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
            json={
                "errors": [
                    {
                        "detail": "You can only report the same IP address once in 15 minutes.",
                        "status": 429,
                        "source": {"parameter": "ip", "value": "3.5.140.2"},
                    }
                ]
            },
            headers={"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "996", "X-RateLimit-Reset": str(RESET)},
        )
    )

    with pytest.raises(AbuseIpdbRateLimitedError) as exc:
        await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
    assert (exc.value.retry_after, exc.value.daily) == (None, False)


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


@pytest.mark.parametrize("endpoint", ["report", "check"])
async def test_transport_error_text_never_reaches_the_traceback(endpoint):
    client, _ = build_client(httpx2.LocalProtocolError("Illegal header value b'test-key\\n'"))

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        if endpoint == "report":
            await client.report("3.5.140.2", [21], "probing", REPORTED_AT)
        else:
            await client.check("3.5.140.2")
    assert exc.value.maybe_sent is (endpoint == "report")
    assert "LocalProtocolError" in exc.value.detail
    assert "test-key" not in "".join(traceback.format_exception(exc.value))


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


GENERATED_AT = datetime(2026, 11, 8, 6, 0, tzinfo=UTC)


def blacklist_body(*ip_addresses: object, generated_at: object = "2026-11-08T06:00:00+00:00") -> dict[str, object]:
    return {
        "meta": {"generatedAt": generated_at},
        "data": [
            {"ipAddress": ip_address, "abuseConfidenceScore": 100, "lastReportedAt": "2026-11-08T05:00:00+00:00"}
            for ip_address in ip_addresses
        ],
    }


async def test_blacklist_sends_the_limit_and_key_and_parses_the_answer():
    client, calls = build_client(httpx2.Response(200, json=blacklist_body("3.5.140.2", "2600:1f18::1")))

    result = await client.blacklist()

    assert result == BlacklistResult(generated_at=GENERATED_AT, ips=["3.5.140.2", "2600:1f18::1"])
    request = calls[0]
    assert request.method == "GET" and request.url.path == "/api/v2/blacklist"
    assert dict(request.url.params) == {"limit": "10000"}
    assert request.headers["Key"] == "test-key"
    assert request.headers["Accept"] == "application/json"


async def test_blacklist_canonicalizes_and_drops_what_is_not_global():
    client, _ = build_client(
        httpx2.Response(
            200,
            json=blacklist_body(
                " 3.5.140.2 ",
                "2600:1F18:0::1",
                "::ffff:3.5.140.9",
                "3.5.140.2",
                "10.0.0.5",
                "203.0.113.7",
                "fe80::1%eth0",
                "not-an-ip",
            ),
        )
    )

    result = await client.blacklist()

    assert result.ips == ["3.5.140.2", "2600:1f18::1", "3.5.140.9"]


async def test_blacklist_remembers_its_own_rate_limit():
    client, _ = build_client(
        httpx2.Response(
            200,
            json=blacklist_body("3.5.140.2"),
            headers={"X-RateLimit-Limit": "5", "X-RateLimit-Remaining": "4", "X-RateLimit-Reset": str(RESET)},
        )
    )

    await client.blacklist()

    assert client.rate_limit("blacklist") == RateLimit(5, 4, datetime.fromtimestamp(RESET, UTC))
    assert client.rate_limit("check") is None


async def test_blacklist_is_never_cached():
    client, calls = build_client(httpx2.Response(200, json=blacklist_body("3.5.140.2")))

    await client.blacklist()
    await client.blacklist()

    assert len(calls) == 2


async def test_blacklist_takes_an_answer_above_the_check_cap():
    ip_addresses = [f"3.{first}.{second}.1" for first in range(5, 60) for second in range(0, 200)]
    response = httpx2.Response(200, json=blacklist_body(*ip_addresses))
    assert len(response.content) > MAX_RESPONSE_BYTES
    client, _ = build_client(response)

    result = await client.blacklist()

    assert len(result.ips) == len(ip_addresses)


async def test_blacklist_refuses_an_answer_above_its_own_cap():
    client, _ = build_client(httpx2.Response(200, content=b"x" * (MAX_BLACKLIST_RESPONSE_BYTES + 1)))

    with pytest.raises(AbuseIpdbUnavailableError, match="oversized"):
        await client.blacklist()


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(503),
        httpx2.Response(200, content=b"<html>"),
        httpx2.Response(200, json=[]),
        httpx2.Response(200, json={"meta": {"generatedAt": "2026-11-08T06:00:00+00:00"}}),
        httpx2.Response(200, json={"data": [{"ipAddress": "3.5.140.2"}]}),
        httpx2.Response(200, json={"meta": None, "data": [{"ipAddress": "3.5.140.2"}]}),
        httpx2.Response(200, json=blacklist_body("3.5.140.2", generated_at="yesterday")),
        httpx2.Response(200, json=blacklist_body("3.5.140.2", generated_at=1762560000)),
        httpx2.Response(200, json=blacklist_body("3.5.140.2", generated_at="2026-11-08T06:00:00")),
        httpx2.Response(200, json={"meta": {"generatedAt": "2026-11-08T06:00:00+00:00"}, "data": {}}),
        httpx2.Response(200, json={"meta": {"generatedAt": "2026-11-08T06:00:00+00:00"}, "data": ["3.5.140.2"]}),
        httpx2.Response(200, json=blacklist_body(None)),
        httpx2.Response(200, json=blacklist_body()),
        httpx2.Response(200, json=blacklist_body("10.0.0.5")),
    ],
    ids=[
        "5xx",
        "not-json",
        "not-an-object",
        "no-data",
        "no-meta",
        "null-meta",
        "unparseable-time",
        "numeric-time",
        "naive-time",
        "data-not-a-list",
        "entry-not-an-object",
        "ip-not-a-string",
        "empty-list",
        "nothing-global",
    ],
)
async def test_blacklist_treats_an_unusable_answer_as_unavailable(response):
    client, _ = build_client(response)

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await client.blacklist()
    assert exc.value.maybe_sent is False


@pytest.mark.parametrize(
    ("response", "expected_error"),
    [
        (httpx2.Response(401, json={"errors": [{"detail": "bad key", "status": 401}]}), AbuseIpdbAuthError),
        (httpx2.Response(422, json={"errors": [{"detail": "bad limit", "status": 422}]}), AbuseIpdbRejectedError),
        (httpx2.Response(429, json={"errors": [{"detail": "daily", "status": 429}]}), AbuseIpdbRateLimitedError),
    ],
    ids=["401", "422", "429"],
)
async def test_blacklist_maps_errors_like_check(response, expected_error):
    client, _ = build_client(response)

    with pytest.raises(expected_error):
        await client.blacklist()


async def test_blacklist_does_not_follow_redirects():
    client, calls = build_client(httpx2.Response(302, headers={"Location": "https://example.com/"}))

    with pytest.raises(AbuseIpdbUnavailableError):
        await client.blacklist()
    assert len(calls) == 1


async def test_blacklist_transport_errors_drop_their_cause():
    client, _ = build_client(httpx2.ReadTimeout("Key: test-key"))

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await client.blacklist()
    assert exc.value.__cause__ is None
    assert "test-key" not in "".join(traceback.format_exception(exc.value))


async def test_blacklist_error_detail_never_contains_the_key():
    client, _ = build_client(httpx2.Response(422, json={"errors": [{"detail": "bad key test-key", "status": 422}]}))

    with pytest.raises(AbuseIpdbRejectedError) as exc:
        await client.blacklist()
    assert "test-key" not in exc.value.detail


@pytest.mark.parametrize(
    ("call", "body"),
    [
        (lambda client: client.blacklist(), blacklist_body("3.5.140.2", generated_at="not a time test-key")),
        (
            lambda client: client.check("3.5.140.2"),
            {"data": {**CHECK_BODY["data"], "lastReportedAt": "not a time test-key"}},
        ),
    ],
    ids=["blacklist-generated-at", "check-last-reported-at"],
)
async def test_a_malformed_timestamp_never_puts_the_key_in_a_traceback(call, body):
    client, _ = build_client(httpx2.Response(200, json=body))

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await call(client)
    assert "test-key" not in "".join(traceback.format_exception(exc.value))


@pytest.mark.parametrize(
    ("call", "response"),
    [
        (lambda client: client.check("3.5.140.2"), httpx2.Response(200, content=b"<html>")),
        (lambda client: client.check("3.5.140.2"), httpx2.Response(200, json={"data": {"ipAddress": None}})),
        (
            lambda client: client.report("3.5.140.2", [21], "probing", REPORTED_AT),
            httpx2.Response(200, json={"data": {"ipAddress": None}}),
        ),
        (lambda client: client.blacklist(), httpx2.Response(200, content=b"<html>")),
        (lambda client: client.blacklist(), httpx2.Response(200, json=blacklist_body(None))),
    ],
    ids=["request-not-json", "check-wrong-type", "report-wrong-type", "blacklist-not-json", "blacklist-wrong-type"],
)
async def test_a_malformed_answer_keeps_no_exception_cause(call, response):
    client, _ = build_client(response)

    with pytest.raises(AbuseIpdbUnavailableError) as exc:
        await call(client)
    assert exc.value.__cause__ is None
