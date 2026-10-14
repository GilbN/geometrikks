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
            lambda fake: setattr(
                fake,
                "payload",
                streams_payload([{"stream": {"job": "nginx"}, "values": [["1" * 20, "line"]]}]),
            ),
            "rejected",
            id="oversized-timestamp",
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
    elsewhere.example. With it off the fake sees exactly one request and the
    source is rejected."""
    fake.fail_next.append(302)
    source = make_source(fake, username="reader", password="s3cret")
    assert await source.recent_lines(3) == []
    assert source.status() == SourceStatus(available=False, reason="rejected")
    assert [request.url.host for request in fake.requests] == ["loki"]


async def test_status_changes_are_logged_once(fake: FakeLoki, clock: list[int]) -> None:
    fake.fail_next.extend([500, 500])
    source = make_source(fake)
    with capture_logs() as logs:
        await source.recent_lines(3)
        await source.recent_lines(3)
        assert [log["event"] for log in logs] == ["loki_source_unreachable"]
        await source.recent_lines(3)
    assert [log["event"] for log in logs] == ["loki_source_unreachable", "loki_source_available"]
    assert source.status() == SourceStatus(available=True)


async def test_recent_lines_orders_entries_across_streams(fake: FakeLoki, clock: list[int]) -> None:
    fake.add(1001, "a-early", {"job": "nginx", "host": "a"})
    fake.add(1002, "b-middle", {"job": "nginx", "host": "b"})
    fake.add(1003, "a-late", {"job": "nginx", "host": "a"})
    source = make_source(fake)
    assert await source.recent_lines(3) == ["a-early", "b-middle", "a-late"]


STATE_EVENTS = {"loki_source_unreachable", "loki_source_rejected", "loki_source_available"}


class Tail:
    """Run lines() in the background and collect what it yields."""

    def __init__(self, source: LokiSource) -> None:
        self.source = source
        self.stop = asyncio.Event()
        self.lines: list[str] = []
        self.task: asyncio.Task[None] | None = None

    async def __aenter__(self) -> "Tail":
        async def run() -> None:
            async for line in self.source.lines(self.stop):
                self.lines.append(line)

        self.task = asyncio.create_task(run())
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.stop.set()
        assert self.task is not None
        await asyncio.wait_for(self.task, timeout=5.0)

    async def polled(self, fake: FakeLoki, requests: int) -> None:
        """Wait until the fake has answered at least ``requests`` requests."""
        await wait_until(lambda: len(fake.requests) >= requests)


def test_loki_source_satisfies_the_protocol(fake: FakeLoki) -> None:
    source: LogSource = make_source(fake)
    assert source.kind == "loki"


async def test_yields_each_line_once_and_never_replays_the_past(
    fake: FakeLoki, clock: list[int]
) -> None:
    fake.add(999, "before startup")  # inside the lookback, before the clock: never yielded
    async with Tail(make_source(fake, lookback=60)) as tail:
        await tail.polled(fake, 1)
        assert tail.lines == []

        fake.add(1001, "first")
        clock[0] = 1002 * NS
        await wait_until(lambda: tail.lines == ["first"])

        await tail.polled(fake, len(fake.requests) + 3)
        assert tail.lines == ["first"]
    assert tail.source.status().available is True
    params = fake.requests[-1].url.params
    assert params["direction"] == "forward"
    assert int(params["start"]) == T0
    assert int(params["end"]) == 1002 * NS


async def test_lines_stamped_during_the_format_check_are_read(
    fake: FakeLoki, clock: list[int]
) -> None:
    """The service calls wait_ready, checks the format, then lines(). A line
    stamped in between must not fall below the start of the first window."""
    source = make_source(fake)
    await source.wait_ready(asyncio.Event())
    fake.add(1001, "during the check")
    clock[0] = 1002 * NS
    async with Tail(source) as tail:
        await wait_until(lambda: tail.lines == ["during the check"])
    assert source._ready_at is None


async def test_late_lines_inside_the_lookback_are_caught(fake: FakeLoki, clock: list[int]) -> None:
    async with Tail(make_source(fake, lookback=60)) as tail:
        await tail.polled(fake, 1)  # floor read at T0
        fake.add(1100, "newest")
        clock[0] = 1101 * NS
        await wait_until(lambda: tail.lines == ["newest"])
        # Reaches Loki after the previous read, stamped before "newest" but
        # inside the window: caught. One outside the window is not.
        fake.add(1050, "late")
        fake.add(1030, "too late")
        await wait_until(lambda: "late" in tail.lines)
        await tail.polled(fake, len(fake.requests) + 3)
    assert tail.lines == ["newest", "late"]


async def test_identical_lines_in_two_streams_are_two_lines(fake: FakeLoki, clock: list[int]) -> None:
    async with Tail(make_source(fake)) as tail:
        await tail.polled(fake, 1)  # floor read at T0
        fake.add(1001, "same", {"job": "nginx", "host": "a"})
        fake.add(1001, "same", {"job": "nginx", "host": "b"})
        clock[0] = 1002 * NS
        await wait_until(lambda: len(tail.lines) == 2)
        await tail.polled(fake, len(fake.requests) + 3)
    assert tail.lines == ["same", "same"]


async def test_lookback_zero_still_yields_each_line_once(fake: FakeLoki, clock: list[int]) -> None:
    async with Tail(make_source(fake, lookback=0)) as tail:
        await tail.polled(fake, 1)  # floor read at T0
        fake.add(1001, "a")
        fake.add(1001, "b")
        clock[0] = 1002 * NS
        await wait_until(lambda: len(tail.lines) == 2)
        await tail.polled(fake, len(fake.requests) + 3)
    assert sorted(tail.lines) == ["a", "b"]


async def test_a_window_larger_than_one_page_is_read_whole(
    fake: FakeLoki, clock: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 2)
    async with Tail(make_source(fake)) as tail:
        await tail.polled(fake, 1)  # floor read at T0
        requests_before = len(fake.requests)
        for second in range(1001, 1006):
            fake.add(second, f"line {second}")
        clock[0] = 1006 * NS
        await wait_until(lambda: len(tail.lines) == 5)
    assert tail.lines == [f"line {second}" for second in range(1001, 1006)]
    assert len(fake.requests) - requests_before >= 3


async def test_a_poll_ends_even_when_loki_keeps_growing(
    fake: FakeLoki, clock: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Entries stamped at or after the poll's end are left for the next poll,
    so a proxy that writes faster than one page per request cannot keep a
    single poll running."""
    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 2)
    for second in range(1001, 1005):
        fake.add(second, f"line {second}")
    end = 1005 * NS
    grown = 0

    real_respond = fake.respond

    def respond_and_grow(request: httpx2.Request) -> httpx2.Response:
        nonlocal grown
        grown += 1
        fake.add_ns(end + grown, f"grown {grown}")
        return real_respond(request)

    source = LokiSource(
        url="http://loki:3100",
        query=QUERY,
        label="loki:1",
        transport=httpx2.MockTransport(respond_and_grow),
    )
    async with source._client() as client:
        pages = [page async for page in source._pages(client, T0, end, asyncio.Event())]

    # Pages overlap by one entry (Loki's start is inclusive); lines() dedups.
    assert sorted({line for page in pages for _, _, line in page}) == [
        f"line {second}" for second in range(1001, 1005)
    ]
    # [1001,1002] [1002,1003] [1003,1004] [1004]: four requests, then done.
    assert len(fake.requests) == 4


async def test_a_stop_between_pages_ends_the_poll(
    fake: FakeLoki, clock: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 1)
    for second in range(1001, 1006):
        fake.add(second, f"line {second}")
    stop = asyncio.Event()
    real_respond = fake.respond

    def respond_then_stop(request: httpx2.Request) -> httpx2.Response:
        stop.set()
        return real_respond(request)

    source = LokiSource(
        url="http://loki:3100",
        query=QUERY,
        label="loki:1",
        transport=httpx2.MockTransport(respond_then_stop),
    )
    async with source._client() as client:
        pages = [page async for page in source._pages(client, T0, 1006 * NS, stop)]

    assert len(pages) == 1
    assert len(fake.requests) == 1


async def test_a_failure_on_a_later_page_keeps_the_earlier_lines(
    fake: FakeLoki, clock: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 2)
    real_respond = fake.respond
    failed_once = False

    def fail_the_second_page_once(request: httpx2.Request) -> httpx2.Response:
        # The first page is [1001, 1002]; the second page is asked from 1002.
        nonlocal failed_once
        if request.url.params["start"] == str(1002 * NS) and not failed_once:
            failed_once = True
            fake.fail_next.append(500)
        return real_respond(request)

    source = LokiSource(
        url="http://loki:3100",
        query=QUERY,
        label="loki:1",
        poll_interval=0.01,
        transport=httpx2.MockTransport(fail_the_second_page_once),
    )
    with capture_logs() as logs:
        async with Tail(source) as tail:
            await tail.polled(fake, 1)  # floor read at T0
            for second in range(1001, 1004):
                fake.add(second, f"line {second}")
            clock[0] = 1004 * NS
            await wait_until(lambda: len(tail.lines) == 3)
    assert tail.lines == ["line 1001", "line 1002", "line 1003"]
    assert [log["event"] for log in logs if log["event"] in STATE_EVENTS] == [
        "loki_source_unreachable",
        "loki_source_available",
    ]


async def test_a_full_page_at_one_timestamp_steps_past_it_and_warns_once(
    fake: FakeLoki, clock: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loki_module, "PAGE_LIMIT", 2)
    # lookback=0: the poll after the crowded one starts at 1002 and does not
    # re-read that nanosecond, so the warning count is per occurrence, not per poll.
    with capture_logs() as logs:
        async with Tail(make_source(fake, lookback=0)) as tail:
            await tail.polled(fake, 1)  # floor read at T0
            fake.add(1001, "a")
            fake.add(1001, "b")
            fake.add(1001, "c")  # beyond the page: lost, by design
            fake.add(1002, "d")
            clock[0] = 1003 * NS
            await wait_until(lambda: "d" in tail.lines)
            await tail.polled(fake, len(fake.requests) + 3)
    assert tail.lines == ["a", "b", "d"]
    warnings = [log for log in logs if log["log_level"] == "warning"]
    assert len(warnings) == 1
    assert warnings[0]["event"].startswith("More than %d lines in %s share the timestamp %s")
    assert warnings[0]["positional_args"][:2] == (2, QUERY)


async def test_unreachable_then_recovers(fake: FakeLoki, clock: list[int]) -> None:
    fake.fail_next.extend([500, 500])
    with capture_logs() as logs:
        async with Tail(make_source(fake)) as tail:
            await wait_until(lambda: not tail.source.status().available)
            assert tail.source.status() == SourceStatus(available=False, reason="unreachable")
            fake.add(1001, "after")
            clock[0] = 1002 * NS
            await wait_until(lambda: tail.lines == ["after"])
    assert tail.source.status().available is True
    assert [log["event"] for log in logs if log["event"] in STATE_EVENTS] == [
        "loki_source_unreachable",
        "loki_source_available",
    ]


async def test_rejected_query_is_retried_every_poll(fake: FakeLoki, clock: list[int]) -> None:
    fake.fail_next.extend([401, 401, 401])
    async with Tail(make_source(fake)) as tail:
        await wait_until(lambda: tail.source.status().reason == "rejected")
        await tail.polled(fake, 4)
        fake.add(1001, "allowed now")
        clock[0] = 1002 * NS
        await wait_until(lambda: tail.lines == ["allowed now"])
    assert tail.source.status().available is True


async def test_stop_ends_a_long_sleep_within_a_tick(fake: FakeLoki, clock: list[int]) -> None:
    tail = Tail(make_source(fake, poll_interval=30.0))
    async with tail:
        await tail.polled(fake, 1)
        loop = asyncio.get_running_loop()
        started = loop.time()
        tail.stop.set()
        assert tail.task is not None
        await asyncio.wait_for(tail.task, timeout=1.0)
        assert loop.time() - started < 1.0
