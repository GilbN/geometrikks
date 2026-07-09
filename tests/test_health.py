"""/health is liveness (always 200); /health/ready is readiness (503 without DB)."""
from __future__ import annotations

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.api import health as health_module
from geometrikks.api.health import health, health_ready


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
