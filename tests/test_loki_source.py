"""LokiSource: polling query_range as a LogSource."""
from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from structlog.testing import capture_logs

from geometrikks.services.logsources import LogSource, LokiSource, SourceStatus
from geometrikks.services.logsources import loki as loki_module
from geometrikks.services.logsources.loki import NS, QUERY_RANGE_PATH

pytestmark = pytest.mark.anyio

QUERY = '{job="nginx"}'
T0 = 1_000 * NS
LINE = (
    '2.125.160.216 - - [03/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
    'example.com "-""0.002" "0.001""City" "CC"'
)


def streams_payload(result: list[dict[str, Any]]) -> dict[str, Any]:
    return {"status": "success", "data": {"resultType": "streams", "result": result}}


class FakeLoki:
    """query_range over an in-memory list of (timestamp_ns, labels, line).

    The idea is from PR #279 by Shoshuo. Honours start, end, limit and
    direction. ``fail_next`` answers the next requests with those HTTP
    statuses (a 3xx carries a cross-host Location), ``errors`` raises
    transport errors ("connect" or "timeout") for the next requests,
    ``payload`` answers with a fixed JSON body, ``text`` with a fixed
    non-JSON body.
    """

    def __init__(self) -> None:
        self.entries: list[tuple[int, dict[str, str], str]] = []
        self.requests: list[httpx2.Request] = []
        self.fail_next: list[int] = []
        self.errors: list[str] = []
        self.payload: dict[str, Any] | None = None
        self.text: str | None = None

    def add(self, seconds: float, line: str, labels: dict[str, str] | None = None) -> None:
        self.add_ns(int(seconds * NS), line, labels)

    def add_ns(self, timestamp_ns: int, line: str, labels: dict[str, str] | None = None) -> None:
        self.entries.append((timestamp_ns, labels or {"job": "nginx"}, line))

    def respond(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.errors:
            error = self.errors.pop(0)
            if error == "timeout":
                raise httpx2.ReadTimeout("slow", request=request)
            raise httpx2.ConnectError("connection refused", request=request)
        if self.fail_next:
            status = self.fail_next.pop(0)
            headers = {"Location": "http://elsewhere.example/steal"} if 300 <= status < 400 else {}
            return httpx2.Response(status, text="boom", headers=headers, request=request)
        if self.payload is not None:
            return httpx2.Response(200, json=self.payload, request=request)
        if self.text is not None:
            return httpx2.Response(200, text=self.text, request=request)
        params = request.url.params
        start = int(params["start"])
        end = int(params["end"]) if "end" in params else 2**63 - 1
        limit = int(params["limit"])
        backward = params.get("direction") == "backward"
        picked = sorted(
            (entry for entry in self.entries if start <= entry[0] < end),
            key=lambda entry: entry[0],
            reverse=backward,
        )[:limit]
        streams: dict[str, dict[str, Any]] = {}
        for timestamp, labels, line in picked:
            key = json.dumps(labels, sort_keys=True)
            streams.setdefault(key, {"stream": labels, "values": []})["values"].append(
                [str(timestamp), line]
            )
        return httpx2.Response(200, json=streams_payload(list(streams.values())), request=request)


@pytest.fixture
def fake() -> FakeLoki:
    return FakeLoki()


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    now = [T0]
    monkeypatch.setattr(loki_module, "_now_ns", lambda: now[0])
    return now


def make_source(fake: FakeLoki, **kwargs) -> LokiSource:
    kwargs.setdefault("url", "http://loki:3100")
    kwargs.setdefault("query", QUERY)
    kwargs.setdefault("label", "loki:1")
    kwargs.setdefault("poll_interval", 0.01)
    return LokiSource(transport=httpx2.MockTransport(fake.respond), **kwargs)


async def wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition not met in time"
        await asyncio.sleep(0.005)


def test_loki_source_carries_its_identity(fake: FakeLoki) -> None:
    source = make_source(fake, hostname="edge-01")
    assert source.kind == "loki"
    assert source.label == "loki:1"
    assert source.hostname == "edge-01"
    assert source.status() == SourceStatus(available=True)


async def test_wait_ready_returns_at_once_and_records_the_clock(
    fake: FakeLoki, clock: list[int]
) -> None:
    source = make_source(fake)
    assert source._ready_at is None
    assert await source.wait_ready(asyncio.Event()) is True
    assert source._ready_at == T0
    assert fake.requests == []


async def test_recent_lines_is_a_backward_sample_returned_oldest_first(
    fake: FakeLoki, clock: list[int]
) -> None:
    fake.add(1001, "one")
    fake.add(1002, "two")
    fake.add(1003, "three")
    source = make_source(fake)

    assert await source.recent_lines(2) == ["two", "three"]

    [request] = fake.requests
    params = request.url.params
    assert request.url.path == QUERY_RANGE_PATH
    assert params["direction"] == "backward"
    assert params["limit"] == "2"
    assert int(params["start"]) == T0 - loki_module.SAMPLE_WINDOW_SECONDS * NS
    assert "end" not in params


async def test_recent_lines_with_nothing_to_sample(fake: FakeLoki, clock: list[int]) -> None:
    source = make_source(fake)
    assert await source.recent_lines(3) == []
    assert await source.recent_lines(0) == []
    assert source.status().available is True


async def test_recent_lines_clears_a_stale_unavailable_flag(fake: FakeLoki, clock: list[int]) -> None:
    source = make_source(fake)
    source._unavailable_reason = "unreachable"
    with capture_logs() as logs:
        await source.recent_lines(3)
    assert source.status() == SourceStatus(available=True)
    assert [log["event"] for log in logs] == ["loki_source_available"]


async def test_sends_tenant_basic_auth_and_the_selector_verbatim(fake: FakeLoki, clock: list[int]) -> None:
    query = '{job="nginx", env="prod"} |= "GET"'
    source = make_source(fake, query=query, tenant_id="team-a", username="reader", password="s3cret")
    await source.recent_lines(3)

    [request] = fake.requests
    assert request.headers["X-Scope-OrgID"] == "team-a"
    expected = base64.b64encode(b"reader:s3cret").decode()
    assert request.headers["Authorization"] == f"Basic {expected}"
    assert request.url.params["query"] == query


async def test_url_path_prefix_is_kept(fake: FakeLoki, clock: list[int]) -> None:
    source = make_source(fake, url="https://grafana.example.com/loki")
    await source.recent_lines(3)
    [request] = fake.requests
    assert request.url.path == "/loki" + QUERY_RANGE_PATH


@pytest.mark.parametrize(
    "arrange, reason",
    [
        pytest.param(lambda fake: fake.fail_next.append(500), "unreachable", id="500"),
        pytest.param(lambda fake: fake.fail_next.append(429), "unreachable", id="429"),
        pytest.param(lambda fake: fake.errors.append("connect"), "unreachable", id="connect-error"),
        pytest.param(lambda fake: fake.errors.append("timeout"), "unreachable", id="timeout"),
        pytest.param(lambda fake: fake.fail_next.append(400), "rejected", id="400"),
        pytest.param(lambda fake: fake.fail_next.append(401), "rejected", id="401"),
        pytest.param(lambda fake: fake.fail_next.append(403), "rejected", id="403"),
        pytest.param(lambda fake: fake.fail_next.append(404), "rejected", id="404-not-a-loki"),
        pytest.param(lambda fake: setattr(fake, "text", "<html>not loki</html>"), "rejected", id="not-json"),
        pytest.param(
            lambda fake: setattr(
                fake,
                "payload",
                {
                    "status": "success",
                    "data": {"resultType": "matrix", "result": [{"metric": {}, "values": [[1001, "42"]]}]},
                },
            ),
            "rejected",
            id="metric-query",
        ),
        pytest.param(
            lambda fake: setattr(
                fake,
                "payload",
                streams_payload([{"stream": {"job": "nginx"}, "values": [["abc", "line"]]}]),
            ),
            "rejected",
            id="malformed-timestamp",
        ),
        pytest.param(
            lambda fake: setattr(
                fake,
                "payload",
                streams_payload([{"stream": {"job": "nginx"}, "values": [["-5", "line"]]}]),
            ),
            "rejected",
            id="negative-timestamp",
        ),
        pytest.param(
            lambda fake: setattr(fake, "payload", {"status": "error", "data": {}}),
            "rejected",
            id="status-error",
        ),
    ],
)
async def test_failures_are_recorded_in_status(
    fake: FakeLoki, clock: list[int], arrange: Callable[[FakeLoki], object], reason: str
) -> None:
    arrange(fake)
    source = make_source(fake)
    with capture_logs() as logs:
        assert await source.recent_lines(3) == []
    assert source.status() == SourceStatus(available=False, reason=reason)
    assert [log["event"] for log in logs] == [f"loki_source_{reason}"]
    assert logs[0]["label"] == "loki:1"
    assert logs[0]["query"] == QUERY


async def test_a_redirect_is_rejected_and_never_followed(fake: FakeLoki, clock: list[int]) -> None:
    """With follow_redirects on, the fake would see a second request for
    elsewhere.example carrying the Authorization header."""
    fake.fail_next.append(302)
    source = make_source(fake, username="reader", password="s3cret")
    assert await source.recent_lines(3) == []
    assert source.status() == SourceStatus(available=False, reason="rejected")
    assert [request.url.host for request in fake.requests] == ["loki"]
