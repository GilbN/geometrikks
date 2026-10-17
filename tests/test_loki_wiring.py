"""Loki inputs are built next to the file inputs at ingestion startup."""
from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import httpx2
import pytest
from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.config.settings import LogParserSettings, LokiSettings, Settings
from geometrikks.domain.system.controllers import health as health_module
from geometrikks.domain.system.controllers.health import health, health_ready
from geometrikks.domain.system.controllers.stats import LokiSourceStats, stats
from geometrikks.server.lifecycle import build_log_inputs
from geometrikks.services.ingestion import LogInput, LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logsources import FileSource, LokiSource
from tests.support import ambient_settings_dependency

URL = "http://loki:3100"
QUERY = '{job="nginx"}'


def test_loki_inputs_follow_the_file_inputs() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(
            _env_file=None, log_paths=[Path("/var/log/access/a.log")], server_name=["head"]
        ),
        loki=LokiSettings(
            _env_file=None,
            url=URL,
            queries=['{job="nginx"}', '{job="traefik"}'],
            formats=["auto", "traefik-json"],
            server_names=["edge-01", "edge-02"],
            tenant_id="team-a",
            username="reader",
            password="s3cret",
            poll_interval=2.5,
            lookback=90,
        ),
    )

    inputs = build_log_inputs(settings)

    assert [log_input.source.kind for log_input in inputs] == ["file", "loki", "loki"]
    assert isinstance(inputs[0].source, FileSource)
    first, second = inputs[1].source, inputs[2].source
    assert isinstance(first, LokiSource) and isinstance(second, LokiSource)
    assert (first.label, second.label) == ("loki:1", "loki:2")
    assert (first.query, second.query) == ('{job="nginx"}', '{job="traefik"}')
    assert (first.hostname, second.hostname) == ("edge-01", "edge-02")
    assert (first.poll_interval, first.lookback) == (2.5, 90)
    assert first._auth == ("reader", "s3cret")
    assert first.tenant_id == "team-a"
    assert inputs[1].parser.source_label == 'loki:{job="nginx"}'
    assert inputs[1].parser.log_format_setting == "auto"
    assert inputs[2].parser.log_format_setting == "traefik-json"


def test_loki_only_builds_no_file_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")  # the suite's baseline pins it
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, server_name=["head"]),
        loki=LokiSettings(_env_file=None, url=URL, queries=['{job="nginx"}']),
    )
    inputs = build_log_inputs(settings)
    assert [log_input.source.kind for log_input in inputs] == ["loki"]
    assert inputs[0].source.hostname == "head"


def test_without_loki_only_file_inputs_are_built() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None),
        loki=LokiSettings(_env_file=None),
    )
    assert [log_input.source.kind for log_input in build_log_inputs(settings)] == ["file"]


def _service_with_loki(reason: str | None) -> LogIngestionService:
    """A real (never-started) service so Litestar DI type validation passes."""
    source = LokiSource(
        url=URL,
        query=QUERY,
        label="loki:1",
        hostname="edge-01",
        transport=httpx2.MockTransport(lambda request: httpx2.Response(500, request=request)),
    )
    source._unavailable_reason = reason
    parser = LogParser(source_label=f"loki:{QUERY}", log_format="nginx")
    parser.parsed_lines = 3
    service = LogIngestionService(
        inputs=[LogInput(source=source, parser=parser)],
        session_maker=cast("Any", None),
        geoip_path="unused",
    )
    service.is_running = True
    return service


@pytest.mark.anyio
async def test_stats_lists_loki_sources() -> None:
    response = await stats.fn(ingestion_service=_service_with_loki("rejected"))
    assert response.loki_sources == [
        LokiSourceStats(
            query=QUERY,
            label="loki:1",
            hostname="edge-01",
            available=False,
            reason="rejected",
            log_format="nginx",
            parsed_lines=3,
        )
    ]


@pytest.mark.anyio
async def test_stats_without_a_service_has_no_loki_sources() -> None:
    response = await stats.fn(ingestion_service=None)
    assert response.loki_sources == []


def test_health_names_the_label_and_never_the_selector(monkeypatch: pytest.MonkeyPatch) -> None:
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True

    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    # Same app as tests/test_health.py::make_app.
    app = Litestar(
        route_handlers=[health, health_ready],
        dependencies=ambient_settings_dependency(),
    )
    app.state.ingestion_service = _service_with_loki("unreachable")

    with TestClient(app=app) as client:
        response = client.get("/health")

    body = response.json()
    assert body["status"] == "degraded"
    assert body["ingestion"]["unavailableSources"] == [
        {"kind": "loki", "label": "loki:1", "reason": "unreachable"}
    ]
    assert body["ingestion"]["missingFiles"] == ["loki:1"]
    assert "nginx" not in response.text
