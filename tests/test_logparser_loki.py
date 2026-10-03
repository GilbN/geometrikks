"""Reading access-log lines from Grafana Loki (LokiParser) and its settings."""
from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx2
import pytest
from geoip2.database import Reader
from pydantic import ValidationError

from geometrikks.config.settings import LogParserSettings
from geometrikks.domain.system.controllers.health import IngestionHealth
from geometrikks.domain.system.controllers.stats import LokiSourceStats, stats
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser import loki
from geometrikks.services.logparser.loki import NS, LokiParser
from geometrikks.services.logparser.schemas import ParsedLogRecord
from tests.test_logparser_formats import CADDY_FULL, TRAEFIK_FULL, gjson

pytestmark = pytest.mark.anyio

GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"
LINES = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()
QUERY = '{job="nginx"}'
T0 = 1_000 * NS


class FakeLoki:
    """query_range over an in-memory list of (ts_ns, labels, line)."""

    def __init__(self) -> None:
        self.entries: list[tuple[int, str, str]] = []
        self.requests: list[httpx2.Request] = []
        self.fail_next = 0

    def add(self, seconds: float, line: str, stream: str = "a") -> None:
        self.entries.append((int(seconds * NS), stream, line))

    def respond(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.fail_next:
            self.fail_next -= 1
            return httpx2.Response(500, text="boom", request=request)
        params = request.url.params
        start, end, limit = int(params["start"]), int(params["end"]), int(params["limit"])
        picked = sorted(e for e in self.entries if start <= e[0] <= end)[:limit]
        streams: dict[str, list[list[str]]] = {}
        for ts, stream, line in picked:
            streams.setdefault(stream, []).append([str(ts), line])
        result = [{"stream": {"s": s}, "values": v} for s, v in streams.items()]
        return httpx2.Response(
            200, json={"status": "success", "data": {"resultType": "streams", "result": result}},
            request=request,
        )


@pytest.fixture
def fake() -> FakeLoki:
    return FakeLoki()


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    now = [T0]
    monkeypatch.setattr(loki, "_now_ns", lambda: now[0])
    return now


@pytest.fixture
def geoip_reader() -> Reader:
    return Reader(GEOIP_DB_PATH)


def make_parser(fake: FakeLoki, poll_interval: float = 0, **kwargs) -> LokiParser:
    parser = LokiParser(
        url="http://loki:3100",
        query=QUERY,
        transport=httpx2.MockTransport(fake.respond),
        send_logs=True,
        poll_interval=poll_interval,
        hostname="edge-01",
        **kwargs,
    )
    parser.set_stop_event(asyncio.Event())
    return parser


async def poll(gen: AsyncGenerator[ParsedLogRecord | None, None]) -> list[ParsedLogRecord]:
    """Records yielded by one read, up to the idle None that ends it."""
    records = []
    while (record := await gen.__anext__()) is not None:
        records.append(record)
    return records


async def test_reads_new_lines_once_and_catches_late_ones(
    fake: FakeLoki, clock: list[int], geoip_reader: Reader
) -> None:
    fake.add(999, LINES[0])  # before startup: never replayed
    parser = make_parser(fake)
    gen = parser.iter_parsed_records(geoip_reader)

    assert await poll(gen) == []

    fake.add(1001, LINES[1])
    clock[0] = 1002 * NS
    first = await poll(gen)
    assert [r.raw_line for r in first] == [LINES[1]]

    # Reaches Loki after the previous read, stamped before it.
    fake.add(1001.5, LINES[2])
    clock[0] = 1005 * NS
    second = await poll(gen)
    assert [r.raw_line for r in second] == [LINES[2]]

    clock[0] = 1010 * NS
    assert await poll(gen) == []
    await gen.aclose()


async def test_records_carry_source_hostname_and_detected_format(
    fake: FakeLoki, clock: list[int], geoip_reader: Reader
) -> None:
    parser = make_parser(fake)
    gen = parser.iter_parsed_records(geoip_reader)
    await poll(gen)
    fake.add(1001, LINES[0])
    clock[0] = 1002 * NS
    [record] = await poll(gen)
    await gen.aclose()

    assert record.ip_address is not None
    assert record.source == f"loki:{QUERY}"
    assert record.hostname == "edge-01"
    assert record.log_format == "nginx"
    assert parser.format is not None and parser.format.name == "nginx"


@pytest.mark.parametrize(
    "line,expected_format",
    [
        pytest.param(TRAEFIK_FULL, "traefik-json", id="traefik"),
        pytest.param(CADDY_FULL, "caddy-json", id="caddy"),
        pytest.param(gjson(), "geometrikks-json", id="nginx-json"),
    ],
)
async def test_any_supported_format_can_come_from_loki(
    fake: FakeLoki, clock: list[int], geoip_reader: Reader, line: str, expected_format: str
) -> None:
    """Loki only carries the line; the format is detected as for a file."""
    parser = make_parser(fake)
    gen = parser.iter_parsed_records(geoip_reader)
    await poll(gen)
    fake.add(1001, line)
    clock[0] = 1002 * NS
    [record] = await poll(gen)
    await gen.aclose()

    assert record.log_format == expected_format
    assert record.ip_address == "203.0.113.7"
    assert record.is_malformed is False


async def test_streams_are_merged_in_timestamp_order_across_pages(
    fake: FakeLoki, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loki, "PAGE_LIMIT", 2)
    fake.add(1001, "a1", stream="a")
    fake.add(1001, "b1", stream="b")  # same timestamp as a1, other stream
    fake.add(1002, "b2", stream="b")
    fake.add(1003, "a2", stream="a")
    fake.add(1004, "b3", stream="b")
    parser = make_parser(fake)

    async with parser._client() as client:
        entries = await parser.fetch(client, T0, 1010 * NS)

    assert [line for _, line in entries] == ["a1", "b1", "b2", "a2", "b3"]
    assert len(fake.requests) > 1


async def test_unreachable_loki_is_reported_then_recovers(
    fake: FakeLoki, clock: list[int], geoip_reader: Reader
) -> None:
    parser = make_parser(fake)
    gen = parser.iter_parsed_records(geoip_reader)
    fake.fail_next = 1

    assert await gen.__anext__() is None
    assert parser.file_missing is True

    fake.add(1001, LINES[0])
    clock[0] = 1002 * NS
    records = await poll(gen)
    await gen.aclose()
    assert [r.raw_line for r in records] == [LINES[0]]
    assert parser.file_missing is False


async def test_sends_tenant_and_basic_auth(
    fake: FakeLoki, clock: list[int], geoip_reader: Reader
) -> None:
    parser = make_parser(fake, tenant_id="team-a", username="reader", password="s3cret")
    gen = parser.iter_parsed_records(geoip_reader)
    await poll(gen)
    await gen.aclose()

    request = fake.requests[0]
    assert request.headers["X-Scope-OrgID"] == "team-a"
    expected = base64.b64encode(b"reader:s3cret").decode()
    assert request.headers["Authorization"] == f"Basic {expected}"
    assert request.url.params["query"] == QUERY
    assert request.url.params["direction"] == "forward"


async def test_ingestion_reads_loki_without_waiting_for_a_file(
    fake: FakeLoki, monkeypatch: pytest.MonkeyPatch
) -> None:
    waited = AsyncMock(return_value=False)
    monkeypatch.setattr("geometrikks.services.ingestion.service.wait_for_path", waited)
    service = LogIngestionService(
        parsers=[make_parser(fake, poll_interval=0.01)],
        session_maker=cast(Any, lambda: None),
        geoip_path=GEOIP_DB_PATH,
    )
    await service.start(skip_validation=True)
    try:
        await asyncio.sleep(0.05)
        waited.assert_not_called()
        assert fake.requests
    finally:
        await service.stop(timeout=1.0)


async def test_stats_lists_loki_sources_and_health_does_not(fake: FakeLoki) -> None:
    """The query and hostname go to the authenticated stats, never the public /health."""
    parser = make_parser(fake)
    parser.parsed_lines = 3
    parser.file_missing = True
    service = LogIngestionService(
        parsers=[parser], session_maker=cast(Any, lambda: None), geoip_path=GEOIP_DB_PATH
    )

    response = await stats.fn(ingestion_service=service)

    assert response.loki_sources == [
        LokiSourceStats(
            query=QUERY, hostname="edge-01", reachable=False, log_format=None, parsed_lines=3
        )
    ]
    assert "loki_sources" not in IngestionHealth.__struct_fields__


def settings(**kwargs) -> LogParserSettings:
    return LogParserSettings(_env_file=None, **kwargs)


def test_settings_loki_only_drops_the_default_log_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS", raising=False)  # set by the conftest baseline
    s = settings(loki_url="http://loki:3100", loki_queries=[QUERY])
    assert s.log_paths == []
    assert s.resolved_loki_sources() == [(QUERY, "auto", s.host_name[0])]


def test_settings_explicit_log_paths_are_kept_next_to_loki() -> None:
    s = settings(
        loki_url="http://loki:3100", loki_queries=[QUERY], log_paths=["/var/log/access/access.log"]
    )
    assert s.log_paths == [Path("/var/log/access/access.log")]


def test_settings_loki_lists_fan_out_and_host_names() -> None:
    s = settings(
        host_name=["files-host"],
        loki_url="http://loki:3100",
        loki_queries=['{job="npm"}', '{job="traefik"}'],
        loki_formats=["nginx", "traefik-json"],
        loki_host_names=["edge-01"],
    )
    sources = s.resolved_loki_sources()
    assert [host for _, _, host in sources] == ["edge-01", "edge-01"]
    assert [fmt for _, fmt, _ in sources] == ["nginx", "traefik-json"]
    assert s.source_hostnames() == ["files-host", "edge-01", "edge-01"]


def test_settings_loki_queries_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOGPARSER_LOKI_URL", "http://loki:3100")
    monkeypatch.setenv("LOGPARSER_LOKI_QUERIES", QUERY)
    assert settings().loki_queries == [QUERY]
    monkeypatch.setenv("LOGPARSER_LOKI_QUERIES", '["{job=\\"a\\"}", "{job=\\"b\\"}"]')
    assert settings().loki_queries == ['{job="a"}', '{job="b"}']


@pytest.mark.parametrize(
    "kwargs",
    [
        pytest.param({"loki_queries": [QUERY]}, id="queries-without-url"),
        pytest.param({"loki_url": "http://loki:3100"}, id="url-without-queries"),
        pytest.param(
            {"loki_url": "http://loki:3100", "loki_queries": [QUERY], "loki_username": "u"},
            id="username-without-password",
        ),
        pytest.param(
            {"loki_url": "http://loki:3100", "loki_queries": [QUERY], "loki_formats": ["bogus"]},
            id="unknown-format",
        ),
        pytest.param(
            {
                "loki_url": "http://loki:3100",
                "loki_queries": [QUERY],
                "loki_host_names": ["a", "b"],
            },
            id="host-names-length",
        ),
        pytest.param({"log_paths": []}, id="no-source-at-all"),
        pytest.param(
            {"loki_url": "http://user:pw@loki:3100", "loki_queries": [QUERY]},
            id="credentials-in-url",
        ),
        pytest.param({"loki_url": "loki:3100", "loki_queries": [QUERY]}, id="no-scheme"),
        pytest.param({"loki_url": "file:///etc/passwd", "loki_queries": [QUERY]}, id="file-scheme"),
    ],
)
def test_settings_loki_rejections(kwargs: dict) -> None:
    with pytest.raises(ValidationError):
        settings(**kwargs)
