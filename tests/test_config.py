"""Tests for configuration management."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from geometrikks.config import GeoIPSettings, MapSettings, Settings, get_settings
from geometrikks.config.settings import LogParserSettings, get_installed_version


def test_default_settings():
    """Test default settings are loaded correctly."""
    settings = Settings()
    
    assert settings.name == "GeoMetrikks API"
    assert settings.version == get_installed_version()
    assert settings.environment == "production"
    assert settings.debug is False


def test_environment_override(monkeypatch):
    """Test that environment variables override defaults."""
    monkeypatch.setenv("APP_NAME", "Custom Name")
    monkeypatch.setenv("APP_DEBUG", "true")
    monkeypatch.setenv("APP_ENVIRONMENT", "development")
    monkeypatch.setenv("APP_VERSION", "9.9.9-test")
    
    settings = Settings()
    
    assert settings.name == "Custom Name"
    assert settings.debug is True
    assert settings.environment == "development"
    assert settings.version == "9.9.9-test"


def test_runtime_metadata_defaults_and_overrides(monkeypatch):
    default_settings = Settings(_env_file=None)
    assert default_settings.runtime == "host"
    assert default_settings.image_tag is None

    monkeypatch.setenv("APP_RUNTIME", "container")
    monkeypatch.setenv("APP_IMAGE_TAG", "v0.2.2-dev.4")
    container_settings = Settings(_env_file=None)
    assert container_settings.runtime == "container"
    assert container_settings.image_tag == "v0.2.2-dev.4"


def test_database_settings():
    """Test database configuration."""
    settings = Settings()
    
    assert "postgresql" in settings.database.url
    assert settings.database.pool_size == 5
    assert settings.database.echo is False


def test_geoip_settings(tmp_path):
    """Test GeoIP configuration."""
    # Create a dummy GeoIP file for testing
    test_db = tmp_path / "test_geoip.mmdb"
    test_db.touch()
    
    settings = Settings(geoip=GeoIPSettings(db_path=test_db))
    assert settings.geoip.db_path == test_db


def test_geoip_missing_file():
    """Test GeoIP validation fails for missing file when validation is enabled."""
    with pytest.raises(ValueError, match="GeoIP database file not found"):
        GeoIPSettings(
            db_path=Path("/nonexistent/file.mmdb"),
            validate_db_path=True  # Enable validation
        )


def test_geoip_missing_file_allowed_by_default():
    """A missing database must not fail settings construction by default:
    the auto-downloader/degraded-mode startup path owns that case."""
    settings = GeoIPSettings(db_path=Path("/nonexistent/file.mmdb"), _env_file=None)
    assert settings.db_path == Path("/nonexistent/file.mmdb")


def test_api_settings():
    """Test API server configuration."""
    settings = Settings()

    assert settings.api.host == "0.0.0.0"
    assert settings.api.port == 8000
    # log_level is now a deprecated fallback; unset unless API_LOG_LEVEL is set.
    assert settings.api.log_level is None


def test_map_home_settings(monkeypatch):
    """Map destination defaults to auto-detection and supports a manual pair."""
    monkeypatch.delenv("MAP_AUTO_DETECT_HOME", raising=False)
    defaults = MapSettings(_env_file=None)
    assert defaults.home_latitude is None
    assert defaults.home_longitude is None
    assert defaults.auto_detect_home is True

    monkeypatch.setenv("MAP_HOME_LATITUDE", "40.7128")
    monkeypatch.setenv("MAP_HOME_LONGITUDE", "-74.0060")
    overridden = MapSettings(_env_file=None)
    assert overridden.home_latitude == 40.7128
    assert overridden.home_longitude == -74.006


@pytest.mark.parametrize(
    ("name", "value"),
    [("MAP_HOME_LATITUDE", "91"), ("MAP_HOME_LONGITUDE", "181")],
)
def test_map_home_settings_validate_coordinate_ranges(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    counterpart = "MAP_HOME_LONGITUDE" if name == "MAP_HOME_LATITUDE" else "MAP_HOME_LATITUDE"
    monkeypatch.setenv(counterpart, "0")
    with pytest.raises(ValueError):
        MapSettings(_env_file=None)


def test_map_home_settings_require_coordinate_pair():
    with pytest.raises(ValueError, match="must be set together"):
        MapSettings(home_latitude=40.7, _env_file=None)


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
    get_settings.cache_clear()
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

    settings = Settings()

    assert settings.is_production
    assert settings.debug is False
    assert "postgresql" in settings.database.url


def test_logparser_default_paths():
    """Default is a single-element list with the classic nginx path."""
    settings = Settings()
    assert settings.logparser.log_paths == [Path("/var/log/nginx/access.log")]


def test_logparser_single_path_env(monkeypatch):
    """A bare path string becomes a one-element list."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", "/var/log/nginx/site.log")
    settings = Settings()
    assert settings.logparser.log_paths == [Path("/var/log/nginx/site.log")]


def test_logparser_json_list_env(monkeypatch):
    """A JSON list of paths is parsed into a list of Paths."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/var/log/nginx/a.log", "/var/log/nginx/b.log"]')
    settings = Settings()
    assert settings.logparser.log_paths == [
        Path("/var/log/nginx/a.log"),
        Path("/var/log/nginx/b.log"),
    ]


def test_logparser_empty_list_rejected(monkeypatch):
    """An empty list of log paths is a configuration error."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", "[]")
    with pytest.raises(ValueError):
        Settings()


def test_logparser_ignore_ips_default_empty():
    """Nothing is ignored unless configured."""
    settings = Settings()
    assert settings.logparser.ignore_ips == []


def test_logparser_ignore_ips_single_value(monkeypatch):
    """A bare IP string becomes a one-element list."""
    monkeypatch.setenv("LOGPARSER_IGNORE_IPS", "203.0.113.7")
    settings = Settings()
    assert settings.logparser.ignore_ips == ["203.0.113.7"]


def test_logparser_ignore_ips_comma_separated(monkeypatch):
    """Comma-separated IPs/CIDRs are split and trimmed."""
    monkeypatch.setenv("LOGPARSER_IGNORE_IPS", "203.0.113.7, 198.51.100.0/24")
    settings = Settings()
    assert settings.logparser.ignore_ips == ["203.0.113.7", "198.51.100.0/24"]


def test_logparser_ignore_ips_json_list(monkeypatch):
    """A JSON list of IPs/CIDRs is parsed as-is, IPv6 included."""
    monkeypatch.setenv("LOGPARSER_IGNORE_IPS", '["203.0.113.7", "2001:db8::/32"]')
    settings = Settings()
    assert settings.logparser.ignore_ips == ["203.0.113.7", "2001:db8::/32"]


def test_logparser_ignore_ips_invalid_entry_rejected(monkeypatch):
    """Entries that are not an IP or CIDR fail settings validation."""
    monkeypatch.setenv("LOGPARSER_IGNORE_IPS", "not-an-ip")
    with pytest.raises(ValidationError, match="not an IP address or CIDR"):
        Settings()


def test_log_formats_default_auto(monkeypatch) -> None:
    """No LOGPARSER_LOG_FORMATS set: default is 'auto' for every log path."""
    monkeypatch.delenv("LOGPARSER_LOG_FORMATS", raising=False)
    settings = LogParserSettings()
    assert settings.log_formats == ["auto"]
    assert settings.resolved_formats() == ["auto"] * len(settings.log_paths)


def test_log_formats_single_value_fans_out(monkeypatch) -> None:
    """A single format value applies to every configured log path."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log"]')
    monkeypatch.setenv("LOGPARSER_LOG_FORMATS", "traefik-json")
    settings = LogParserSettings()
    assert settings.resolved_formats() == ["traefik-json", "traefik-json"]


def test_log_formats_json_list_positional(monkeypatch) -> None:
    """A JSON list of formats maps positionally onto log_paths."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log"]')
    monkeypatch.setenv("LOGPARSER_LOG_FORMATS", '["nginx", "traefik-json"]')
    settings = LogParserSettings()
    assert settings.resolved_formats() == ["nginx", "traefik-json"]


def test_log_formats_length_mismatch_rejected(monkeypatch) -> None:
    """A format list whose length matches neither 1 nor len(log_paths) fails."""
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log", "/c.log"]')
    monkeypatch.setenv("LOGPARSER_LOG_FORMATS", '["nginx", "traefik-json"]')
    with pytest.raises(ValidationError):
        LogParserSettings()


def test_log_formats_unknown_value_rejected(monkeypatch) -> None:
    """An unrecognized format name fails settings validation."""
    monkeypatch.setenv("LOGPARSER_LOG_FORMATS", "apache")
    with pytest.raises(ValidationError):
        LogParserSettings()


class TestAuthSettings:
    """APP_ADMIN_USER / APP_ADMIN_PASSWORD / APP_AUTH_DISABLED."""

    def test_auth_defaults(self):
        # _env_file=None: a local .env (e.g. APP_ADMIN_PASSWORD for dev) must
        # not leak into the defaults under test.
        settings = Settings(_env_file=None)
        assert settings.auth_disabled is False
        assert settings.admin_user == "admin"
        assert settings.admin_password is None

    def test_auth_env_overrides(self, monkeypatch):
        monkeypatch.setenv("APP_AUTH_DISABLED", "true")
        monkeypatch.setenv("APP_ADMIN_USER", "gil")
        monkeypatch.setenv("APP_ADMIN_PASSWORD", "bestpasswordintheworldnojoke")
        settings = Settings()
        assert settings.auth_disabled is True
        assert settings.admin_user == "gil"
        assert settings.admin_password is not None
        assert settings.admin_password.get_secret_value() == "bestpasswordintheworldnojoke"


class TestGeoIPDownloadSettings:
    """MAXMINDDB_USER_ID / MAXMINDDB_LICENSE_KEY / GEOIP_REFRESH_DAYS."""

    def test_defaults(self, monkeypatch):
        # _env_file=None + delenv: local MaxMind credentials must not leak in.
        for var in ("MAXMINDDB_USER_ID", "MAXMINDDB_LICENSE_KEY", "GEOIP_REFRESH_DAYS"):
            monkeypatch.delenv(var, raising=False)
        from geometrikks.config.settings import GeoIPSettings
        s = GeoIPSettings(validate_db_path=False, _env_file=None)
        assert s.account_id is None
        assert s.license_key is None
        assert s.refresh_days == 7

    def test_env(self, monkeypatch):
        monkeypatch.setenv("MAXMINDDB_USER_ID", "123456")
        monkeypatch.setenv("MAXMINDDB_LICENSE_KEY", "abcdef")
        monkeypatch.setenv("GEOIP_REFRESH_DAYS", "3")
        from geometrikks.config.settings import GeoIPSettings
        s = GeoIPSettings(validate_db_path=False)
        assert s.account_id == "123456"
        assert s.license_key is not None
        assert s.license_key.get_secret_value() == "abcdef"
        assert s.refresh_days == 3


def test_db_password_is_secret_but_url_works(monkeypatch):
    from geometrikks.config.settings import DatabaseSettings
    monkeypatch.setenv("DB_PASSWORD", "s3cret-db-pass")
    s = DatabaseSettings()
    assert "s3cret-db-pass" not in repr(s)
    assert "s3cret-db-pass" in s.url


def test_db_url_encodes_reserved_characters(monkeypatch):
    from geometrikks.config.settings import DatabaseSettings
    monkeypatch.setenv("DB_USER", "geo@user")
    monkeypatch.setenv("DB_PASSWORD", "p@ss:w/rd%1")
    s = DatabaseSettings()
    assert "geo%40user:p%40ss%3Aw%2Frd%251@" in s.url
    assert "p@ss:w/rd%1" not in s.url


def test_license_key_is_secret(monkeypatch):
    from geometrikks.config.settings import GeoIPSettings
    monkeypatch.setenv("MAXMINDDB_LICENSE_KEY", "lk-secret")
    s = GeoIPSettings()
    assert "lk-secret" not in repr(s)
    assert s.license_key is not None
    assert s.license_key.get_secret_value() == "lk-secret"


def test_admin_password_is_secret_and_auth_still_verifies(monkeypatch):
    from geometrikks.config.settings import Settings
    from geometrikks.server.auth import build_auth_state
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "admin-secret-pass")
    s = Settings()
    assert "admin-secret-pass" not in repr(s)
    state = build_auth_state(s)
    assert state.verify("admin", "admin-secret-pass")


def test_build_auth_state_rejects_empty_password(monkeypatch):
    import pytest
    from geometrikks.config.settings import Settings
    from geometrikks.server.auth import build_auth_state
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "")
    with pytest.raises(RuntimeError):
        build_auth_state(Settings())


class TestCrowdSecSettings:
    """CrowdSec integration settings: enablement tiers and credential pairing."""

    def test_disabled_by_default(self):
        from geometrikks.config.settings import CrowdSecSettings
        s = CrowdSecSettings(_env_file=None)
        assert s.enabled is False
        assert s.write_enabled is False

    def test_enabled_with_url_and_bouncer_key(self, monkeypatch):
        from geometrikks.config.settings import CrowdSecSettings
        monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
        monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "bouncer-key")
        s = CrowdSecSettings(_env_file=None)
        assert s.enabled is True
        assert s.write_enabled is False

    def test_url_alone_is_not_enabled(self, monkeypatch):
        from geometrikks.config.settings import CrowdSecSettings
        monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
        s = CrowdSecSettings(_env_file=None)
        assert s.enabled is False

    def test_write_enabled_with_machine_credentials(self, monkeypatch):
        from geometrikks.config.settings import CrowdSecSettings
        monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
        monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "bouncer-key")
        monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
        monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "machine-pass")
        s = CrowdSecSettings(_env_file=None)
        assert s.write_enabled is True

    def test_machine_credentials_must_be_paired(self, monkeypatch):
        import pytest
        from pydantic import ValidationError
        from geometrikks.config.settings import CrowdSecSettings
        monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
        with pytest.raises(ValidationError):
            CrowdSecSettings(_env_file=None)

    def test_secrets_are_redacted_in_repr(self, monkeypatch):
        from geometrikks.config.settings import CrowdSecSettings
        monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "bouncer-secret")
        monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
        monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "machine-secret")
        s = CrowdSecSettings(_env_file=None)
        assert "bouncer-secret" not in repr(s)
        assert "machine-secret" not in repr(s)
        assert s.bouncer_api_key is not None
        assert s.machine_password is not None
        assert s.bouncer_api_key.get_secret_value() == "bouncer-secret"
        assert s.machine_password.get_secret_value() == "machine-secret"

    def test_registered_on_settings(self, monkeypatch, tmp_path):
        # chdir away from the repo: the nested CrowdSecSettings factory reads
        # ./.env itself, so a local .env with CROWDSEC_* would leak in even
        # though the parent gets _env_file=None.
        monkeypatch.chdir(tmp_path)
        s = Settings(_env_file=None)
        assert s.crowdsec.enabled is False
        assert s.crowdsec.default_ban_duration == "4h"
        assert s.crowdsec.request_timeout == 10.0
        assert s.crowdsec.verify_tls is True


def test_crowdsec_stream_poll_interval(monkeypatch):
    from geometrikks.config.settings import CrowdSecSettings
    assert CrowdSecSettings(_env_file=None).stream_poll_interval == 15.0
    monkeypatch.setenv("CROWDSEC_STREAM_POLL_INTERVAL", "5")
    assert CrowdSecSettings(_env_file=None).stream_poll_interval == 5.0


class TestProxySettings:
    def test_trusted_proxies_default_empty(self):
        assert Settings(_env_file=None).trusted_proxies == []

    def test_trusted_proxies_comma_separated(self):
        s = Settings(trusted_proxies="172.18.0.0/16, 10.0.0.5", _env_file=None)
        assert s.trusted_proxies == ["172.18.0.0/16", "10.0.0.5"]

    def test_trusted_proxies_json_list(self):
        s = Settings(trusted_proxies='["172.18.0.0/16"]', _env_file=None)
        assert s.trusted_proxies == ["172.18.0.0/16"]

    def test_trusted_proxies_empty_string_is_empty(self):
        assert Settings(trusted_proxies="", _env_file=None).trusted_proxies == []

    def test_trusted_proxies_invalid_entry_fails_at_load(self):
        with pytest.raises(ValidationError):
            Settings(trusted_proxies="not-an-ip", _env_file=None)

    def test_session_secure_defaults_false(self):
        assert Settings(_env_file=None).session_secure is False


class TestLogSettings:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        from geometrikks.config.settings import Settings
        s = Settings(_env_file=None)
        assert s.log.dir == Path("logs")
        assert s.log.level == "INFO"
        assert s.log.main_max_bytes == 10 * 1024 * 1024
        assert s.log.main_backup_count == 5
        assert s.log.login_max_bytes == 10 * 1024 * 1024
        assert s.log.login_backup_count == 5

    def test_log_level_env(self, monkeypatch):
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        from geometrikks.config.settings import Settings
        assert Settings(_env_file=None).log.level == "DEBUG"

    def test_deprecated_api_log_level_used_when_log_level_unset(self, monkeypatch):
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        monkeypatch.setenv("API_LOG_LEVEL", "WARNING")
        from geometrikks.config.settings import Settings
        with pytest.warns(DeprecationWarning, match="API_LOG_LEVEL is deprecated"):
            s = Settings(_env_file=None)
        assert s.log.level == "WARNING"

    def test_log_level_overrides_deprecated_var(self, monkeypatch):
        monkeypatch.setenv("LOG_LEVEL", "ERROR")
        monkeypatch.setenv("API_LOG_LEVEL", "DEBUG")
        from geometrikks.config.settings import Settings
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error")  # no DeprecationWarning may fire
            s = Settings(_env_file=None)
        assert s.log.level == "ERROR"
