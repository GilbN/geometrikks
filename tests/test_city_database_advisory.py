"""The City database failure is visible when log ingestion is enabled."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

from geometrikks.config.settings import Settings
from geometrikks.domain.system.controllers import health
from geometrikks.lib.utils import GeoIPInfoView
from geometrikks.server import timescale


def _city_advisories(monkeypatch, *, available: bool, ingestion_enabled: bool):
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    monkeypatch.setattr(
        health,
        "geoip_info",
        lambda path: GeoIPInfoView(
            available=available,
            db_path=str(path),
            build_date=None,
            age_days=None,
        ),
    )
    settings = Settings()
    settings.app.proxy_advisory = False
    settings.logparser.enabled = ingestion_enabled
    app = SimpleNamespace(
        state=SimpleNamespace(
            geoip_available=available,
            asn_available=False,
        )
    )
    return health._collect_advisories(cast("Any", app), settings)


def test_missing_city_database_emits_advisory_when_ingestion_is_enabled(monkeypatch):
    advisories = _city_advisories(
        monkeypatch,
        available=False,
        ingestion_enabled=True,
    )

    [advisory] = [item for item in advisories if item.id == "geoip-database-missing"]
    assert advisory.severity == "warning"
    assert "City" in advisory.summary
    assert "MAXMINDDB_USER_ID" in (advisory.remedy or "")
    assert "MAXMINDDB_LICENSE_KEY" in (advisory.remedy or "")


def test_city_database_advisory_is_absent_when_database_is_available(monkeypatch):
    advisories = _city_advisories(
        monkeypatch,
        available=True,
        ingestion_enabled=True,
    )

    assert all(item.id != "geoip-database-missing" for item in advisories)


def test_city_database_advisory_is_absent_when_ingestion_is_disabled(monkeypatch):
    advisories = _city_advisories(
        monkeypatch,
        available=False,
        ingestion_enabled=False,
    )

    assert all(item.id != "geoip-database-missing" for item in advisories)


def test_city_database_advisory_is_distinct_from_stale_database(monkeypatch):
    """A usable but old file keeps the stale advisory path instead."""
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    monkeypatch.setattr(
        health,
        "geoip_info",
        lambda path: GeoIPInfoView(
            available=True,
            db_path=str(path),
            build_date=None,
            age_days=31,
        ),
    )
    monkeypatch.setattr(health, "has_credentials", lambda settings: False)
    settings = Settings()
    settings.app.proxy_advisory = False
    settings.logparser.enabled = True
    app = SimpleNamespace(
        state=SimpleNamespace(geoip_available=True, asn_available=False)
    )

    advisories = health._collect_advisories(cast("Any", app), settings)
    ids = [item.id for item in advisories]
    assert "geoip-database-stale" in ids
    assert "geoip-database-missing" not in ids
