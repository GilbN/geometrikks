"""Health advisories for ingestion failures after startup."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

from geometrikks.config.settings import Settings
from geometrikks.domain.system.controllers.health import _collect_advisories
from geometrikks.lib.advisories import Advisory, AdvisoryRegistry
from geometrikks.server import timescale


def _advisories(monkeypatch, *, unexpected_stop: bool, registry=None):
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    settings = Settings()
    settings.app.proxy_advisory = False
    settings.logparser.enabled = True
    app = SimpleNamespace(
        state=SimpleNamespace(
            advisories=registry,
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


def test_computed_critical_advisory_precedes_registry_warnings(monkeypatch):
    registry = AdvisoryRegistry()
    registry.set(Advisory(id="first-warning", severity="warning", summary="First"))
    registry.set(Advisory(id="second-warning", severity="warning", summary="Second"))
    registry.set(Advisory(id="registry-critical", severity="critical", summary="Critical"))

    advisories = _advisories(monkeypatch, unexpected_stop=True, registry=registry)
    relevant = [a.id for a in advisories if a.id in {
        "first-warning", "second-warning", "registry-critical", "ingestion-stopped",
    }]
    assert relevant == [
        "registry-critical", "ingestion-stopped", "first-warning", "second-warning",
    ]
