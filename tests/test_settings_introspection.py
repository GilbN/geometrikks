"""Settings introspection: full overview, descriptions, type-enforced redaction."""
from __future__ import annotations

from geometrikks.config.introspection import SECRET_PLACEHOLDER, build_settings_overview
from geometrikks.config.settings import Settings


def _section(overview, name):
    return next(s for s in overview.sections if s.name == name)


def _field(section, key):
    return next(f for f in section.fields if f.key == key)


def test_secret_values_never_appear(monkeypatch):
    monkeypatch.setenv("DB_PASSWORD", "super-secret-db-pass")
    monkeypatch.setenv("MAXMINDDB_LICENSE_KEY", "maxmind-secret-key")
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "admin-secret-pass")
    overview = build_settings_overview(Settings())
    flat = str(overview)
    for secret in ("super-secret-db-pass", "maxmind-secret-key", "admin-secret-pass"):
        assert secret not in flat

    pw = _field(_section(overview, "database"), "password")
    assert pw.is_secret is True
    assert pw.value == SECRET_PLACEHOLDER


def test_unset_secret_reports_none():
    # Explicit init args beat env and .env, so this stays green even when a
    # local .env has MaxMind credentials configured.
    from geometrikks.config.settings import GeoIPSettings
    overview = build_settings_overview(Settings(geoip=GeoIPSettings(license_key=None)))
    lk = _field(_section(overview, "geoip"), "license_key")
    assert lk.is_secret is True
    assert lk.value is None


def test_env_var_names_honor_prefix_and_alias():
    overview = build_settings_overview(Settings())
    assert _field(_section(overview, "geoip"), "license_key").env_var == "MAXMINDDB_LICENSE_KEY"
    assert _field(_section(overview, "database"), "host").env_var == "DB_HOST"
    assert _field(_section(overview, "app"), "debug").env_var == "APP_DEBUG"


def test_descriptions_defaults_and_sections_present():
    overview = build_settings_overview(Settings())
    names = [s.name for s in overview.sections]
    for expected in ("app", "api", "database", "geoip", "logparser", "analytics", "scheduler", "map", "vite"):
        assert expected in names

    host = _field(_section(overview, "database"), "host")
    assert host.description == "Database host"
    assert host.default == "localhost"

    # default_factory fields report a None default (dynamic)
    version = _field(_section(overview, "app"), "version")
    assert version.default is None
    assert version.value  # current value still present


def test_app_section_excludes_sub_models():
    overview = build_settings_overview(Settings())
    app_keys = {f.key for f in _section(overview, "app").fields}
    assert "database" not in app_keys
    assert "name" in app_keys
