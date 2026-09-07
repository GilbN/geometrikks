"""Health advisories for ingestion failures after startup."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

from geometrikks.config.settings import Settings
from geometrikks.domain.system.controllers.health import _collect_advisories
from geometrikks.server import timescale


def _advisories(monkeypatch, *, unexpected_stop: bool):
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    settings = Settings()
    settings.app.proxy_advisory = False
    settings.logparser.enabled = True
    app = SimpleNamespace(
        state=SimpleNamespace(
            geoip_available=True,
            asn_available=True,
            ingestion_service=SimpleNamespace(
                unexpected_stop=unexpected_stop,
                failed_batches=0,
                failed_records=0,
                is_running=not unexpected_stop,
            ),
        )
    )
    return _collect_advisories(cast("Any", app), settings)


def test_unexpected_ingestion_stop_emits_critical_advisory(monkeypatch):
    [advisory] = [
        item for item in _advisories(monkeypatch, unexpected_stop=True)
        if item.id == "ingestion-stopped"
    ]

    assert advisory.severity == "critical"
    assert "new records" in advisory.summary
    assert "restart" in (advisory.detail or "").lower()


def test_running_ingestion_has_no_stopped_advisory(monkeypatch):
    assert all(
        item.id != "ingestion-stopped"
        for item in _advisories(monkeypatch, unexpected_stop=False)
    )
