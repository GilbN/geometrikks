import pytest
from pydantic import ValidationError

from geometrikks.config.settings import AbuseIpdbSettings, Settings


def test_defaults_are_off(monkeypatch):
    for name in ("ABUSEIPDB_API_KEY", "ABUSEIPDB_REPORTING_ENABLED", "ABUSEIPDB_REQUEST_TIMEOUT"):
        monkeypatch.delenv(name, raising=False)
    settings = AbuseIpdbSettings()
    assert settings.enabled is False
    assert settings.reporting_enabled is False
    assert settings.request_timeout == 10.0


def test_key_enables_checks_only(monkeypatch):
    monkeypatch.setenv("ABUSEIPDB_API_KEY", "k" * 80)
    monkeypatch.delenv("ABUSEIPDB_REPORTING_ENABLED", raising=False)
    settings = AbuseIpdbSettings()
    assert settings.enabled is True
    assert settings.reporting_enabled is False


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_key_reads_as_unset(monkeypatch, blank):
    monkeypatch.setenv("ABUSEIPDB_API_KEY", blank)
    assert AbuseIpdbSettings().api_key is None


@pytest.mark.parametrize("padded", ["abc \n", "  abc", "abc\r\n"])
def test_key_is_stripped(monkeypatch, padded):
    monkeypatch.setenv("ABUSEIPDB_API_KEY", padded)
    api_key = AbuseIpdbSettings().api_key
    assert api_key is not None
    assert api_key.get_secret_value() == "abc"


def test_reporting_without_key_fails_at_startup(monkeypatch):
    monkeypatch.delenv("ABUSEIPDB_API_KEY", raising=False)
    monkeypatch.setenv("ABUSEIPDB_REPORTING_ENABLED", "true")
    with pytest.raises(ValidationError, match="ABUSEIPDB_REPORTING_ENABLED requires ABUSEIPDB_API_KEY"):
        AbuseIpdbSettings()


def test_timeout_must_be_positive(monkeypatch):
    monkeypatch.setenv("ABUSEIPDB_REQUEST_TIMEOUT", "0")
    with pytest.raises(ValidationError):
        AbuseIpdbSettings()


def test_settings_exposes_the_section():
    assert isinstance(Settings().abuseipdb, AbuseIpdbSettings)
