"""LOKI_* settings and the rule that a Loki-only install tails no file."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

from geometrikks.config.introspection import build_settings_overview
from geometrikks.config.settings import LogParserSettings, LokiSettings, Settings

URL = "http://loki:3100"
QUERY_A = '{job="nginx"}'
QUERY_B = '{job="traefik"}'


def loki(**kwargs) -> LokiSettings:
    return LokiSettings(_env_file=None, **kwargs)


def test_defaults_mean_no_loki_source() -> None:
    settings = loki()
    assert settings.url is None
    assert settings.queries == []
    assert settings.formats == ["auto"]
    assert settings.server_names == []
    assert settings.poll_interval == 5.0
    assert settings.lookback == 60.0


def test_single_values_fan_out_over_queries() -> None:
    settings = loki(url=URL, queries=[QUERY_A, QUERY_B], formats=["nginx"], server_names=["edge"])
    assert settings.resolved_formats() == ["nginx", "nginx"]
    assert settings.resolved_server_names("fallback") == ["edge", "edge"]


def test_lists_map_by_position_and_empty_server_names_use_the_default() -> None:
    settings = loki(
        url=URL, queries=[QUERY_A, QUERY_B], formats=["nginx", "traefik-json"]
    )
    assert settings.resolved_formats() == ["nginx", "traefik-json"]
    assert settings.resolved_server_names("fallback") == ["fallback", "fallback"]


def test_env_accepts_a_single_selector_or_a_json_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKI_URL", URL)
    monkeypatch.setenv("LOKI_QUERIES", '{job="nginx", env="prod"}')
    assert LokiSettings().queries == ['{job="nginx", env="prod"}']

    monkeypatch.setenv("LOKI_QUERIES", '["{job=\\"nginx\\"}", "{job=\\"traefik\\"}"]')
    monkeypatch.setenv("LOKI_SERVER_NAMES", '["edge-01", "edge-02"]')
    settings = LokiSettings()
    assert settings.queries == [QUERY_A, QUERY_B]
    assert settings.server_names == ["edge-01", "edge-02"]


def test_trailing_slash_is_stripped_from_the_url() -> None:
    assert loki(url="http://loki:3100/", queries=[QUERY_A]).url == "http://loki:3100"


@pytest.mark.parametrize(
    "kwargs, message",
    [
        pytest.param({"queries": [QUERY_A]}, "LOKI_QUERIES needs LOKI_URL", id="queries-without-url"),
        pytest.param({"url": URL}, "LOKI_URL needs at least one LOKI_QUERIES", id="url-without-queries"),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "username": "reader"},
            "LOKI_USERNAME and LOKI_PASSWORD must be set together",
            id="username-only",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "password": "s3cret"},
            "LOKI_USERNAME and LOKI_PASSWORD must be set together",
            id="password-only",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "formats": ["syslog"]},
            "Unknown Loki log format",
            id="unknown-format",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A, QUERY_B], "formats": ["nginx", "nginx", "nginx"]},
            "LOKI_FORMATS must be one value or match LOKI_QUERIES in length (2)",
            id="formats-length",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "server_names": ["a", "b"]},
            "LOKI_SERVER_NAMES must be one value or match LOKI_QUERIES in length (1)",
            id="server-names-length",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "server_names": [" "]},
            "LOKI_SERVER_NAMES entries must be non-empty",
            id="blank-server-name",
        ),
        pytest.param(
            {"url": URL, "queries": [" "]},
            "LOKI_QUERIES entries must be non-empty",
            id="blank-query",
        ),
        pytest.param(
            {"url": "loki:3100", "queries": [QUERY_A]},
            "LOKI_URL must be an absolute http(s) URL",
            id="url-without-scheme",
        ),
        pytest.param(
            {"url": "http://loki:bad", "queries": [QUERY_A]},
            "LOKI_URL has an invalid port",
            id="url-invalid-port",
        ),
        pytest.param(
            {"url": "http://reader:s3cret@loki:3100", "queries": [QUERY_A]},
            "LOKI_URL must not contain credentials",
            id="url-with-credentials",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "tenant_id": "café"},
            "LOKI_TENANT_ID must be ASCII",
            id="non-ascii-tenant-id",
        ),
        pytest.param(
            {"url": URL, "queries": [QUERY_A], "poll_interval": 0},
            "greater than 0",
            id="zero-poll-interval",
        ),
    ],
)
def test_rejections(kwargs: dict, message: str) -> None:
    with pytest.raises(ValidationError, match=re.escape(message)):
        loki(**kwargs)


def test_empty_tenant_id_means_no_tenant() -> None:
    assert loki(url=URL, queries=[QUERY_A], tenant_id="").tenant_id is None
    assert loki(url=URL, queries=[QUERY_A], tenant_id=" team-a ").tenant_id == "team-a"


def test_loki_only_install_tails_no_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")  # the suite's baseline pins it
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None),
        loki=loki(url=URL, queries=[QUERY_A]),
    )
    assert settings.logparser.log_paths == []


def test_explicit_log_paths_are_kept_next_to_loki() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, log_paths=[Path("/var/log/access/a.log")]),
        loki=loki(url=URL, queries=[QUERY_A]),
    )
    assert settings.logparser.log_paths == [Path("/var/log/access/a.log")]


def test_without_loki_the_default_file_stays(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")
    settings = Settings(_env_file=None, logparser=LogParserSettings(_env_file=None), loki=loki())
    assert settings.logparser.log_paths == [Path("/var/log/access/access.log")]


def test_env_log_paths_count_as_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    """The baseline env sets LOGPARSER_LOG_PATHS; that is an explicit choice and is kept."""
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None),
        loki=loki(url=URL, queries=[QUERY_A]),
    )
    assert settings.logparser.log_paths == [Path("/var/log/access/access.log")]


def test_ingest_server_names_is_files_then_loki_without_duplicates() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(
            _env_file=None,
            log_paths=[Path("/a.log"), Path("/b.log")],
            server_name=["edge-01", "edge-02"],
        ),
        loki=loki(url=URL, queries=[QUERY_A, QUERY_B], server_names=["edge-02", "edge-03"]),
    )
    assert settings.ingest_server_names() == ["edge-01", "edge-02", "edge-03"]


def test_loki_only_ingest_server_names_fall_back_to_the_first_server_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, server_name=["head"]),
        loki=loki(url=URL, queries=[QUERY_A]),
    )
    assert settings.ingest_server_names() == ["head"]


def test_without_queries_no_server_names_or_formats_resolve() -> None:
    settings = loki(server_names=["unused"], formats=["nginx"])
    assert settings.resolved_server_names("head") == []
    assert settings.resolved_formats() == []


def test_unused_loki_server_names_do_not_reach_ingest_server_names() -> None:
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, server_name=["head"]),
        loki=loki(server_names=["unused"]),
    )
    assert settings.ingest_server_names() == ["head"]


def test_password_is_a_secret_and_never_in_the_overview() -> None:
    settings = Settings(
        _env_file=None,
        loki=loki(url=URL, queries=[QUERY_A], username="reader", password="hunter2"),
    )
    assert isinstance(settings.loki.password, SecretStr)
    overview = build_settings_overview(settings)
    assert "hunter2" not in str(overview)


def test_loki_only_first_ingest_server_name_is_the_first_loki_server_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """import-logs stamps ingest_server_names()[0], so imports match live Loki rows."""
    monkeypatch.delenv("LOGPARSER_LOG_PATHS")
    settings = Settings(
        _env_file=None,
        logparser=LogParserSettings(_env_file=None, server_name=["head"]),
        loki=loki(url=URL, queries=[QUERY_A], server_names=["edge-01"]),
    )
    assert settings.ingest_server_names()[0] == "edge-01"
