"""Old env var names keep working next to their server-named replacements."""

import socket
from typing import Any, NamedTuple

import pytest
from pydantic import ValidationError

from geometrikks.config.settings import LegacyEnvName, Settings


class RenamedEnvVar(NamedTuple):
    old: str
    new: str
    sample: str
    other_sample: str
    section: str
    field: str
    parsed: Any


RENAMED_ENV_VARS = [
    RenamedEnvVar(
        "LOGPARSER_HOST_NAME", "LOGPARSER_SERVER_NAME", "edge-01", "edge-02",
        "logparser", "server_name", ["edge-01"],
    ),
    RenamedEnvVar(
        "MAP_HOME_LOCATIONS", "MAP_SERVER_LOCATIONS",
        '{"edge-01": [59.9, 10.7]}', '{"edge-02": [60.1, 11.2]}',
        "map", "server_locations", {"edge-01": (59.9, 10.7)},
    ),
    RenamedEnvVar(
        "MAP_HOME_LATITUDE", "MAP_SERVER_LATITUDE", "59.9", "60.1",
        "map", "server_latitude", 59.9,
    ),
    RenamedEnvVar(
        "MAP_HOME_LONGITUDE", "MAP_SERVER_LONGITUDE", "10.7", "11.2",
        "map", "server_longitude", 10.7,
    ),
    RenamedEnvVar(
        "MAP_AUTO_DETECT_HOME", "MAP_AUTO_DETECT_SERVER_LOCATION", "false", "true",
        "map", "auto_detect_server_location", False,
    ),
    RenamedEnvVar(
        "MAP_HOME_REFRESH_HOURS", "MAP_SERVER_LOCATION_REFRESH_HOURS", "6", "12",
        "map", "server_location_refresh_hours", 6,
    ),
]

# A lone coordinate fails the pair check, so each coordinate test sets the
# other half under its new name.
COORDINATE_COUNTERPARTS = {
    "MAP_SERVER_LATITUDE": ("MAP_SERVER_LONGITUDE", "10.7"),
    "MAP_SERVER_LONGITUDE": ("MAP_SERVER_LATITUDE", "59.9"),
}


@pytest.fixture(autouse=True)
def clear_renamed_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    for renamed_env_var in RENAMED_ENV_VARS:
        monkeypatch.delenv(renamed_env_var.old, raising=False)
        monkeypatch.delenv(renamed_env_var.new, raising=False)


def _prepare(monkeypatch: pytest.MonkeyPatch, renamed_env_var: RenamedEnvVar) -> None:
    counterpart = COORDINATE_COUNTERPARTS.get(renamed_env_var.new)
    if counterpart is not None:
        monkeypatch.setenv(*counterpart)


def _value(settings: Settings, renamed_env_var: RenamedEnvVar) -> Any:
    return getattr(getattr(settings, renamed_env_var.section), renamed_env_var.field)


def _ids(renamed_env_var: RenamedEnvVar) -> str:
    return renamed_env_var.old


@pytest.mark.parametrize("renamed_env_var", RENAMED_ENV_VARS, ids=_ids)
def test_new_name_only(monkeypatch: pytest.MonkeyPatch, renamed_env_var: RenamedEnvVar) -> None:
    _prepare(monkeypatch, renamed_env_var)
    monkeypatch.setenv(renamed_env_var.new, renamed_env_var.sample)

    settings = Settings(_env_file=None)

    assert _value(settings, renamed_env_var) == renamed_env_var.parsed
    assert settings.legacy_env_names_in_use() == []


@pytest.mark.parametrize("renamed_env_var", RENAMED_ENV_VARS, ids=_ids)
def test_old_name_only(monkeypatch: pytest.MonkeyPatch, renamed_env_var: RenamedEnvVar) -> None:
    _prepare(monkeypatch, renamed_env_var)
    monkeypatch.setenv(renamed_env_var.old, renamed_env_var.sample)

    settings = Settings(_env_file=None)

    assert _value(settings, renamed_env_var) == renamed_env_var.parsed
    assert settings.legacy_env_names_in_use() == [
        LegacyEnvName(old=renamed_env_var.old, new=renamed_env_var.new)
    ]


@pytest.mark.parametrize("renamed_env_var", RENAMED_ENV_VARS, ids=_ids)
def test_both_same_value(monkeypatch: pytest.MonkeyPatch, renamed_env_var: RenamedEnvVar) -> None:
    _prepare(monkeypatch, renamed_env_var)
    monkeypatch.setenv(renamed_env_var.old, renamed_env_var.sample)
    monkeypatch.setenv(renamed_env_var.new, renamed_env_var.sample)

    settings = Settings(_env_file=None)

    assert _value(settings, renamed_env_var) == renamed_env_var.parsed
    assert settings.legacy_env_names_in_use() == [
        LegacyEnvName(old=renamed_env_var.old, new=renamed_env_var.new)
    ]


@pytest.mark.parametrize("renamed_env_var", RENAMED_ENV_VARS, ids=_ids)
def test_both_different_values(
    monkeypatch: pytest.MonkeyPatch, renamed_env_var: RenamedEnvVar
) -> None:
    _prepare(monkeypatch, renamed_env_var)
    monkeypatch.setenv(renamed_env_var.old, renamed_env_var.sample)
    monkeypatch.setenv(renamed_env_var.new, renamed_env_var.other_sample)

    with pytest.raises(ValidationError, match=f"{renamed_env_var.new}.*{renamed_env_var.old}"):
        Settings(_env_file=None)


def test_same_value_different_syntax(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOGPARSER_HOST_NAME", "edge-01")
    monkeypatch.setenv("LOGPARSER_SERVER_NAME", '["edge-01"]')

    settings = Settings(_env_file=None)

    assert settings.logparser.server_name == ["edge-01"]
    assert settings.legacy_env_names_in_use() == [
        LegacyEnvName(old="LOGPARSER_HOST_NAME", new="LOGPARSER_SERVER_NAME")
    ]


def test_neither_set_uses_default() -> None:
    settings = Settings(_env_file=None)

    assert settings.logparser.server_name == [socket.gethostname()]
    assert settings.legacy_env_names_in_use() == []


def test_every_old_name_in_use_is_listed_in_table_order(monkeypatch: pytest.MonkeyPatch) -> None:
    for renamed_env_var in reversed(RENAMED_ENV_VARS):
        monkeypatch.setenv(renamed_env_var.old, renamed_env_var.sample)

    settings = Settings(_env_file=None)

    assert settings.legacy_env_names_in_use() == [
        LegacyEnvName(old=renamed_env_var.old, new=renamed_env_var.new)
        for renamed_env_var in RENAMED_ENV_VARS
    ]


def test_old_name_entries_are_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOGPARSER_HOST_NAME", '["edge-01", ""]')

    with pytest.raises(ValidationError, match="LOGPARSER_HOST_NAME entries must be non-empty"):
        Settings(_env_file=None)


def test_old_name_length_must_match_log_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log", "/c.log"]')
    monkeypatch.setenv("LOGPARSER_HOST_NAME", '["edge-01", "edge-02"]')

    with pytest.raises(ValidationError, match="must be one value or match"):
        Settings(_env_file=None)


def test_old_coordinate_alone_fails_the_pair_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAP_HOME_LATITUDE", "59.9")

    with pytest.raises(ValidationError, match="must be set together"):
        Settings(_env_file=None)


def test_empty_old_server_locations_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAP_HOME_LOCATIONS", "{}")

    settings = Settings(_env_file=None)

    assert settings.map.server_locations == {}
    assert settings.legacy_env_names_in_use() == []


def test_empty_old_server_locations_does_not_conflict_with_new_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAP_HOME_LOCATIONS", "{}")
    monkeypatch.setenv("MAP_SERVER_LOCATIONS", '{"a": [1, 2]}')

    settings = Settings(_env_file=None)

    assert settings.map.server_locations == {"a": (1.0, 2.0)}
    assert settings.legacy_env_names_in_use() == []


def test_old_name_set_to_false_still_counts_as_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAP_AUTO_DETECT_HOME", "false")

    settings = Settings(_env_file=None)

    assert settings.map.auto_detect_server_location is False
    assert settings.legacy_env_names_in_use() == [
        LegacyEnvName(old="MAP_AUTO_DETECT_HOME", new="MAP_AUTO_DETECT_SERVER_LOCATION")
    ]


def test_loki_host_names_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKI_URL", "http://loki:3100")
    monkeypatch.setenv("LOKI_QUERIES", '{job="traefik"}')
    monkeypatch.setenv("LOKI_HOST_NAMES", "edge-01")

    settings = Settings(_env_file=None)

    assert settings.loki.server_names == []
    assert settings.legacy_env_names_in_use() == []
