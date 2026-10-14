"""Loki inputs are built next to the file inputs at ingestion startup."""
from __future__ import annotations

from pathlib import Path

import pytest

from geometrikks.config.settings import LogParserSettings, LokiSettings, Settings
from geometrikks.server.lifecycle import build_log_inputs
from geometrikks.services.logsources import FileSource, LokiSource

URL = "http://loki:3100"


def test_loki_inputs_follow_the_file_inputs() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(
            _env_file=None, log_paths=[Path("/var/log/access/a.log")], host_name=["head"]
        ),
        loki=LokiSettings(
            _env_file=None,
            url=URL,
            queries=['{job="nginx"}', '{job="traefik"}'],
            formats=["auto", "traefik-json"],
            host_names=["edge-01", "edge-02"],
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
    assert first._tenant_id == "team-a"
    assert inputs[1].parser.source_label == 'loki:{job="nginx"}'
    assert inputs[1].parser.log_format_setting == "auto"
    assert inputs[2].parser.log_format_setting == "traefik-json"


def test_loki_only_builds_no_file_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")  # the suite's baseline pins it
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, host_name=["head"]),
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
