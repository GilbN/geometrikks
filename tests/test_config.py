"""Tests for configuration management."""

from pathlib import Path

import pytest

from geometrikks.config import DatabaseSettings, GeoIPSettings, Settings, get_settings


def test_default_settings():
    """Test default settings are loaded correctly."""
    settings = Settings()
    
    assert settings.name == "GeoMetrikks API"
    assert settings.version == "0.1.0"
    assert settings.environment == "development"
    assert settings.debug is False


def test_environment_override(monkeypatch):
    """Test that environment variables override defaults."""
    monkeypatch.setenv("APP_NAME", "Custom Name")
    monkeypatch.setenv("APP_DEBUG", "true")
    monkeypatch.setenv("APP_ENVIRONMENT", "production")
    
    settings = Settings()
    
    assert settings.name == "Custom Name"
    assert settings.debug is True
    assert settings.environment == "production"


def test_database_settings():
    """Test database configuration."""
    settings = Settings()
    
    assert "postgresql" in settings.database.url
    assert settings.database.pool_size == 5
    assert settings.database.echo is False


def test_geoip_settings():
    """Test GeoIP configuration."""
    # Create a dummy GeoIP file for testing
    test_db = Path("test_geoip.mmdb")
    test_db.touch()
    
    try:
        settings = Settings(geoip=GeoIPSettings(db_path=test_db))
        assert settings.geoip.db_path == test_db
        assert settings.geoip.cache_enabled is True
    finally:
        test_db.unlink()


def test_geoip_missing_file():
    """Test GeoIP validation fails for missing file when validation is enabled."""
    with pytest.raises(ValueError, match="GeoIP database file not found"):
        GeoIPSettings(
            db_path=Path("/nonexistent/file.mmdb"),
            validate_db_path=True  # Enable validation
        )


def test_api_settings():
    """Test API server configuration."""
    settings = Settings()
    
    assert settings.api.host == "0.0.0.0"
    assert settings.api.port == 8000
    assert settings.api.log_level in ["debug", "info", "warning", "error", "critical"]


def test_environment_properties():
    """Test environment helper properties."""
    dev_settings = Settings(environment="development")
    assert dev_settings.is_development is True
    assert dev_settings.is_production is False
    
    prod_settings = Settings(environment="production")
    assert prod_settings.is_production is True
    assert prod_settings.is_development is False


def test_settings_caching():
    """Test that get_settings returns cached instance."""
    settings1 = get_settings()
    settings2 = get_settings()
    
    # Should be the same instance due to @lru_cache
    assert settings1 is settings2


def test_nested_settings_override(monkeypatch):
    """Test overriding nested settings via environment variables."""
    monkeypatch.setenv("DB_POOL_SIZE", "20")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "50")
    monkeypatch.setenv("API_PORT", "9000")
    
    settings = Settings()
    
    assert settings.database.pool_size == 20
    assert settings.database.max_overflow == 50
    assert settings.api.port == 9000


def test_list_settings_from_env(monkeypatch):
    """Test list settings can be set via environment variables."""
    monkeypatch.setenv("GEOIP_LOCALES", '["de"]')
    
    settings = Settings()
    
    assert "de" in settings.geoip.locales
    assert len(settings.geoip.locales) == 1


def test_production_configuration(monkeypatch):
    """Test a typical production configuration."""
    monkeypatch.setenv("APP_ENVIRONMENT", "production")
    monkeypatch.setenv("APP_DEBUG", "false")
    monkeypatch.setenv("API_WORKERS", "4")
    
    settings = Settings()
    
    assert settings.is_production
    assert settings.debug is False
    assert "postgresql" in settings.database.url
    assert settings.api.workers == 4
