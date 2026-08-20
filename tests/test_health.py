"""/health is liveness (always 200); /health/ready is readiness (503 without DB)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.domain.system.controllers import health as health_module
from geometrikks.domain.system.controllers.health import health, health_ready
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from tests.support import ambient_settings_dependency


def make_app() -> Litestar:
    # No ingestion service in app.state -> degraded mode
    return Litestar(
        route_handlers=[health, health_ready],
        dependencies=ambient_settings_dependency(),
    )


def test_health_returns_200_even_when_degraded(monkeypatch):
    async def db_down(app, timeout: float = 2.0) -> bool:
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
    async def db_down(app, timeout: float = 2.0) -> bool:
        return False
    monkeypatch.setattr(health_module, "_database_reachable", db_down)

    with TestClient(app=make_app()) as client:
        assert client.get("/health/ready").status_code == 503


def test_ready_200_when_db_reachable(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        res = client.get("/health/ready")
        assert res.status_code == 200
        assert res.json() == {"ready": True}


def test_ready_503_for_agent_with_schema_timeout(monkeypatch):
    """A schema-timeout agent never starts ingestion; a reachable DB alone
    must not report it ready. Staying 503 makes an orchestrator restart it,
    which re-runs the schema wait."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("APP_MODE", "agent")

    app = make_app()
    app.state.schema_wait_result = "timeout"
    with TestClient(app=app) as client:
        res = client.get("/health/ready")
    assert res.status_code == 503
    assert res.json() == {"ready": False}


def test_ready_200_for_agent_past_schema_gate(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("APP_MODE", "agent")

    for result in ("ready", "newer"):
        app = make_app()
        app.state.schema_wait_result = result
        with TestClient(app=app) as client:
            assert client.get("/health/ready").status_code == 200


def _running_service(file_missing: bool) -> "LogIngestionService":
    """A real (never-started) service so Litestar DI type validation passes."""
    parser = LogParser(log_path=Path("nginx_logs/access.log"))
    parser.file_missing = file_missing
    service = LogIngestionService(
        parsers=[parser], session_maker=cast("Any", None), geoip_path="unused"
    )
    service.is_running = True
    return service


def test_health_degraded_when_tailed_file_missing(monkeypatch):
    """Ingestion running but a tailed log file has disappeared -> degraded,
    and the missing paths are surfaced in the payload."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.ingestion_service = _running_service(file_missing=True)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["ingestion"]["running"] is True
    assert body["ingestion"]["missingFiles"] == ["nginx_logs/access.log"]


def test_health_exposes_uptime_and_activity_fields(monkeypatch):
    """started_at, ingestion.last_record_at and geoip.db_modified_at are
    present and null-safe: no app state and no GeoIP file must not break the
    probe."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    # make_app has no started_at in state and no ingestion service
    assert body["startedAt"] is None
    assert body["ingestion"]["lastRecordAt"] is None
    assert "dbBuildDate" in body["geoip"]


def test_health_started_at_from_app_state(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from datetime import datetime, timezone

    app = make_app()
    app.state.started_at = datetime(2026, 7, 31, 8, 0, 0, tzinfo=timezone.utc)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["startedAt"] == "2026-07-31T08:00:00+00:00"


def test_health_no_missing_files_stays_healthy(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.ingestion_service = _running_service(file_missing=False)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["status"] == "healthy"
    assert body["ingestion"]["missingFiles"] == []


def test_health_crowdsec_disabled_by_default(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["crowdsec"] == {"enabled": False, "lapiReachable": None}


def test_health_crowdsec_enabled_and_down(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.crowdsec_service = object()
    app.state.crowdsec_stream_poller = SimpleNamespace(lapi_reachable=False)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["crowdsec"] == {"enabled": True, "lapiReachable": False}
    # CrowdSec being down must not degrade the app status by itself
    assert body["status"] == "degraded"  # degraded because no ingestion in make_app


def test_health_full_mode_running_status(monkeypatch):
    """Full mode (default APP_MODE) with a running service reports mode
    "full" and ingestion.status "running", alongside the legacy boolean."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    app.state.ingestion_service = _running_service(file_missing=False)
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["mode"] == "full"
    assert body["ingestion"]["status"] == "running"
    assert body["ingestion"]["running"] is True
    assert body["schemaWait"] is None


def test_health_ingestion_status_degraded_when_service_not_running(monkeypatch):
    """A constructed-but-not-running service reports ingestion.status
    "degraded", with the legacy `running` boolean staying False alongside
    it -- pins the side-by-side compatibility contract for the degraded leg."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    service = _running_service(file_missing=False)
    service.is_running = False
    app.state.ingestion_service = service
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["ingestion"]["status"] == "degraded"
    assert body["ingestion"]["running"] is False


def test_health_logparser_disabled_is_not_degraded(monkeypatch):
    """LOGPARSER_ENABLED=false reports ingestion.status "disabled" and the
    overall status stays healthy -- disabled-by-config is not an outage."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("LOGPARSER_ENABLED", "false")

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["ingestion"]["status"] == "disabled"
    assert body["ingestion"]["running"] is False
    assert body["status"] == "healthy"


def test_health_agent_mode_reports_schema_wait(monkeypatch):
    """Agent mode surfaces mode == "agent" and the recorded schema_wait_result."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("APP_MODE", "agent")

    app = make_app()
    app.state.schema_wait_result = "ready"
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["mode"] == "agent"
    assert body["schemaWait"] == "ready"


def test_health_has_no_advisories_when_clean(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    monkeypatch.setattr(timescale, "_hostname_pollution", None)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["advisories"] == []


def test_health_reports_hostname_pollution_advisory(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    from geometrikks.server.timescale import HostnamePollution
    monkeypatch.setattr(
        timescale, "_hostname_pollution",
        HostnamePollution(distinct_count=40, container_id_count=38),
    )
    monkeypatch.setattr(timescale, "_location_caggs_have_hostname", False)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    data = body["advisories"]
    assert len(data) == 1
    a = data[0]
    assert a["id"] == "hostname-pollution"
    assert a["severity"] == "warning"
    assert "38" in a["summary"] and "40" in a["summary"]
    assert "backfill-hostname" in a["remedy"]


def test_health_reports_hostname_count_advisory_without_container_ids(monkeypatch):
    """Above the ceiling with no container IDs, the advisory must not claim
    the hostnames look like container IDs, and the count must read as the
    floor the capped probe actually proved."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    from geometrikks.server.timescale import DISTINCT_HOSTNAME_CEILING, HostnamePollution
    monkeypatch.setattr(
        timescale, "_hostname_pollution",
        HostnamePollution(distinct_count=DISTINCT_HOSTNAME_CEILING + 1, container_id_count=0),
    )
    monkeypatch.setattr(timescale, "_location_caggs_have_hostname", False)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    data = body["advisories"]
    assert len(data) == 1
    a = data[0]
    assert a["id"] == "hostname-count"
    assert "container ID" not in a["summary"]
    assert f"{DISTINCT_HOSTNAME_CEILING}+" in a["summary"]
    assert "real source" in a["detail"]


def test_health_no_pollution_advisory_when_caggs_already_have_hostname(monkeypatch):
    """Polluted history is moot once the location CAGGs already carry the
    hostname dimension (fresh install / post-consolidation migration): the
    filter is not unaggregated and no migration is pending, so the advisory
    must not fire."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    from geometrikks.server.timescale import HostnamePollution
    monkeypatch.setattr(
        timescale, "_hostname_pollution",
        HostnamePollution(distinct_count=40, container_id_count=38),
    )
    monkeypatch.setattr(timescale, "_location_caggs_have_hostname", True)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["advisories"] == []


def test_health_no_pollution_advisory_when_not_polluted(monkeypatch):
    """A cached, non-None HostnamePollution that is not actually `polluted`
    (few container-ID-looking hostnames) must not raise the advisory,
    regardless of the CAGG capability flag."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    from geometrikks.server.timescale import HostnamePollution
    monkeypatch.setattr(
        timescale, "_hostname_pollution",
        HostnamePollution(distinct_count=3, container_id_count=0),
    )
    monkeypatch.setattr(timescale, "_location_caggs_have_hostname", False)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["advisories"] == []


def test_health_publish_dropped_present(monkeypatch):
    """publish_dropped surfaces the ingestion service's counter, defaulting
    to 0 when there is no service."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    app = make_app()
    service = _running_service(file_missing=False)
    service.publish_dropped = 3
    app.state.ingestion_service = service
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["ingestion"]["publishDropped"] == 3

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["ingestion"]["publishDropped"] == 0
