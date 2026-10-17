"""The heartbeat payload: schemas, lenient decoding, rolling counters and the builder."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

import httpx2
import pytest
from litestar import Litestar

from geometrikks.config.settings import AppSettings, Settings
from geometrikks.domain.instances.payload import RollingCounter, build_payload
from geometrikks.domain.instances.schemas import decode_payload, payload_advisories
from geometrikks.services.ingestion import LogInput, LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logsources import FileSource, LokiSource


@pytest.fixture(autouse=True)
def isolate_computed_advisories(monkeypatch: pytest.MonkeyPatch) -> None:
    from geometrikks.server import timescale

    monkeypatch.setattr(timescale, "_policy_failures", [], raising=False)


def _settings(**app_overrides: Any) -> Settings:
    return Settings(_env_file=None, app=AppSettings(_env_file=None, **app_overrides))


def _service_with_two_sources() -> LogIngestionService:
    file_source = FileSource(Path("nginx_logs/access.log"), server="web-01")
    loki_source = LokiSource(
        url="http://loki:3100",
        query='{job="nginx"}',
        label="loki:1",
        server="edge-01",
        transport=httpx2.MockTransport(lambda request: httpx2.Response(500, request=request)),
    )
    loki_source._unavailable_reason = "rejected"
    loki_parser = LogParser(source_label="loki:1", log_format="nginx")
    loki_parser.parsed_lines = 3
    service = LogIngestionService(
        inputs=[
            LogInput(source=file_source, parser=LogParser(source_label="file")),
            LogInput(source=loki_source, parser=loki_parser),
        ],
        session_maker=cast("Any", None),
        geoip_path="unused",
    )
    service.is_running = True
    return service


def test_decode_ignores_unknown_keys() -> None:
    raw = {
        "futureKey": 1,
        "sources": [{"kind": "file", "label": "a", "serverName": "s", "futureKey": True}],
    }
    payload = decode_payload(raw)
    assert payload is not None
    assert payload.sources[0].server_name == "s"


def test_decode_tolerates_unknown_advisory_severity() -> None:
    raw = {"health": {"advisories": [{"id": "x", "severity": "info", "summary": "s"}]}}
    payload = decode_payload(raw)
    assert payload is not None
    advisories = payload_advisories(payload)
    assert [(advisory.id, advisory.severity) for advisory in advisories] == [("x", "info")]


def test_payload_advisories_skips_malformed_entries() -> None:
    raw = {"health": {"advisories": [{"severity": "info"}, "junk", {"id": "ok"}]}}
    payload = decode_payload(raw)
    assert payload is not None
    assert [advisory.id for advisory in payload_advisories(payload)] == ["ok"]


def test_decode_of_garbage_returns_none() -> None:
    assert decode_payload({"jobs": "not-a-list"}) is None


def test_decode_parses_iso_datetimes() -> None:
    payload = decode_payload({"nameConflictAt": "2026-10-17T10:00:00+00:00"})
    assert payload is not None
    assert payload.name_conflict_at == datetime(2026, 10, 17, 10, tzinfo=timezone.utc)


def test_rolling_counter_reports_none_until_window_filled() -> None:
    counter = RollingCounter()
    assert counter.sample(0, 100) is None
    assert counter.sample(150, 150) is None


def test_rolling_counter_reports_increase_over_window() -> None:
    counter = RollingCounter()
    counter.sample(0, 100)
    counter.sample(150, 150)
    assert counter.sample(300, 400) == 300


def test_rolling_counter_slides_and_stays_bounded() -> None:
    counter = RollingCounter()
    for second in range(0, 3000, 30):
        counter.sample(second, second * 2)
    assert counter.sample(3000, 6000) == 600
    assert len(counter._samples) <= 12


def test_build_payload_without_ingestion_or_scheduler() -> None:
    payload = build_payload(
        Litestar(route_handlers=[]),
        _settings(),
        lines_5m=None,
        failed_5m=None,
        recent_starts=[],
        name_conflict_at=None,
    )
    assert payload.sources == []
    assert payload.jobs == []
    assert payload.last_error is None
    assert payload.health["ingestion"]["running"] is False
    assert payload.instance_name_source == "fallback"


def test_build_payload_lists_every_source() -> None:
    app = Litestar(route_handlers=[])
    app.state.ingestion_service = _service_with_two_sources()
    payload = build_payload(
        app,
        _settings(),
        lines_5m=7,
        failed_5m=0,
        recent_starts=[],
        name_conflict_at=None,
    )
    by_kind = {source.kind: source for source in payload.sources}
    assert by_kind["file"].server_name == "web-01"
    assert by_kind["file"].available is True
    assert by_kind["loki"].server_name == "edge-01"
    assert by_kind["loki"].available is False
    assert by_kind["loki"].reason == "rejected"
    assert by_kind["loki"].log_format == "nginx"
    assert by_kind["loki"].parsed_lines == 3
    assert (payload.lines_5m, payload.failed_5m) == (7, 0)


def test_build_payload_round_trips_through_decode() -> None:
    import msgspec

    app = Litestar(route_handlers=[])
    app.state.ingestion_service = _service_with_two_sources()
    payload = build_payload(
        app,
        _settings(),
        lines_5m=1,
        failed_5m=0,
        recent_starts=[datetime(2026, 10, 17, tzinfo=timezone.utc)],
        name_conflict_at=None,
    )
    decoded = decode_payload(msgspec.to_builtins(payload))
    assert decoded == payload


def test_agent_schema_wait_reports_waiting_before_result() -> None:
    payload = build_payload(
        Litestar(route_handlers=[]),
        _settings(mode="agent"),
        lines_5m=None,
        failed_5m=None,
        recent_starts=[],
        name_conflict_at=None,
    )
    assert payload.health["schemaWait"] == "waiting"
