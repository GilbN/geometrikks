"""/health is liveness (always 200); /health/ready is readiness (503 without DB)."""
from __future__ import annotations

from types import SimpleNamespace

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.api import health as health_module
from geometrikks.api.health import health, health_ready
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser


def make_app() -> Litestar:
    # No ingestion service in app.state -> degraded mode
    return Litestar(route_handlers=[health, health_ready])


def test_health_returns_200_even_when_degraded(monkeypatch):
    async def db_down(timeout: float = 2.0) -> bool:
        return False
    monkeypatch.setattr(health_module, "_database_reachable", db_down)

    with TestClient(app=make_app()) as client:
        res = client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "degraded"
        assert body["ingestion"]["running"] is False
        assert body["database"]["reachable"] is False


def test_ready_503_when_db_unreachable(monkeypatch):
    async def db_down(timeout: float = 2.0) -> bool:
        return False
    monkeypatch.setattr(health_module, "_database_reachable", db_down)

    with TestClient(app=make_app()) as client:
        assert client.get("/health/ready").status_code == 503


def test_ready_200_when_db_reachable(monkeypatch):
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        res = client.get("/health/ready")
        assert res.status_code == 200
        assert res.json() == {"ready": True}


def _running_service(file_missing: bool) -> "LogIngestionService":
    """A real (never-started) service so Litestar DI type validation passes."""
    parser = LogParser(log_path="nginx_logs/access.log")
    parser.file_missing = file_missing
    service = LogIngestionService(
        parsers=[parser], session_maker=None, geoip_path="unused"
    )
    service.is_running = True
    return service


def test_health_degraded_when_tailed_file_missing(monkeypatch):
    """Ingestion running but a tailed log file has disappeared -> degraded,
    and the missing paths are surfaced in the payload."""
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.ingestion_service = _running_service(file_missing=True)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["ingestion"]["running"] is True
    assert body["ingestion"]["missing_files"] == ["nginx_logs/access.log"]


def test_health_exposes_uptime_and_activity_fields(monkeypatch):
    """started_at, ingestion.last_record_at and geoip.db_modified_at are
    present and null-safe: no app state and no GeoIP file must not break the
    probe."""
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    # make_app has no started_at in state and no ingestion service
    assert body["started_at"] is None
    assert body["ingestion"]["last_record_at"] is None
    assert "db_modified_at" in body["geoip"]


def test_health_started_at_from_app_state(monkeypatch):
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from datetime import datetime, timezone

    app = make_app()
    app.state.started_at = datetime(2026, 7, 31, 8, 0, 0, tzinfo=timezone.utc)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["started_at"] == "2026-07-31T08:00:00+00:00"


def test_health_no_missing_files_stays_healthy(monkeypatch):
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.ingestion_service = _running_service(file_missing=False)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["status"] == "healthy"
    assert body["ingestion"]["missing_files"] == []


def test_health_crowdsec_disabled_by_default(monkeypatch):
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["crowdsec"] == {"enabled": False, "lapi_reachable": None}


def test_health_crowdsec_enabled_and_down(monkeypatch):
    async def db_up(timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.crowdsec_service = object()
    app.state.crowdsec_stream_poller = SimpleNamespace(lapi_reachable=False)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["crowdsec"] == {"enabled": True, "lapi_reachable": False}
    # CrowdSec being down must not degrade the app status by itself
    assert body["status"] == "degraded"  # degraded because no ingestion in make_app
