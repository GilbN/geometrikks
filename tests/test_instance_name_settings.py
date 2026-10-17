import pytest
from pydantic import ValidationError

from geometrikks.config.settings import AppSettings, Settings


def test_unset_name_falls_back_per_mode(monkeypatch) -> None:
    monkeypatch.delenv("APP_INSTANCE_NAME", raising=False)

    monkeypatch.setenv("APP_MODE", "agent")
    monkeypatch.setenv("LOGPARSER_ENABLED", "true")
    agent_settings = Settings(_env_file=None)
    assert agent_settings.resolved_instance_name == "agent"
    assert agent_settings.instance_name_source == "fallback"

    monkeypatch.setenv("APP_MODE", "full")
    full_settings = Settings(_env_file=None)
    assert full_settings.resolved_instance_name == "head"
    assert full_settings.instance_name_source == "fallback"


def test_configured_name_is_stripped(monkeypatch) -> None:
    monkeypatch.setenv("APP_INSTANCE_NAME", "  edge  ")
    settings = Settings(_env_file=None)
    assert settings.resolved_instance_name == "edge"
    assert settings.instance_name_source == "configured"


def test_blank_name_counts_as_unset(monkeypatch) -> None:
    monkeypatch.setenv("APP_INSTANCE_NAME", "   ")
    settings = Settings(_env_file=None)
    assert settings.app.instance_name is None
    assert settings.resolved_instance_name == "head"
    assert settings.instance_name_source == "fallback"


def test_name_with_slash_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("APP_INSTANCE_NAME", "edge/one")
    with pytest.raises(ValidationError, match="APP_INSTANCE_NAME"):
        AppSettings(_env_file=None)


def test_name_over_255_chars_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("APP_INSTANCE_NAME", "a" * 256)
    with pytest.raises(ValidationError, match="APP_INSTANCE_NAME"):
        AppSettings(_env_file=None)


def test_name_of_255_chars_is_accepted(monkeypatch) -> None:
    monkeypatch.setenv("APP_INSTANCE_NAME", "a" * 255)
    assert AppSettings(_env_file=None).instance_name == "a" * 255
