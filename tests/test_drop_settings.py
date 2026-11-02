"""DROP_* settings: on by default, refreshed daily, never faster than hourly."""
import pytest
from pydantic import ValidationError

from geometrikks.config.settings import DropSettings, Settings


def drop(**kwargs) -> DropSettings:
    return DropSettings(_env_file=None, **kwargs)


def test_defaults() -> None:
    settings = drop()
    assert settings.enabled is True
    assert settings.refresh_hours == 24


def test_read_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DROP_ENABLED", "false")
    monkeypatch.setenv("DROP_REFRESH_HOURS", "6")
    settings = drop()
    assert settings.enabled is False
    assert settings.refresh_hours == 6


def test_refresh_hours_below_one_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DROP_REFRESH_HOURS", "0")
    with pytest.raises(ValidationError):
        drop()


def test_settings_aggregate_exposes_drop() -> None:
    assert isinstance(Settings(_env_file=None).drop, DropSettings)
