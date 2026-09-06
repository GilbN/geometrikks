"""/health is liveness (always 200); /health/ready is readiness (503 without DB)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.domain.system.controllers import health as health_module
from geometrikks.domain.system.controllers.health import health, health_ready
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from tests.support import ambient_settings_dependency


@pytest.fixture(autouse=True)
def isolate_computed_advisories(monkeypatch: pytest.MonkeyPatch) -> None:
    from geometrikks.lib.utils import GeoIPInfoView
    from geometrikks.server import timescale

    monkeypatch.setattr(timescale, "_policy_failures", [], raising=False)
    monkeypatch.setattr(
        health_module,
        "geoip_info",
        lambda path: GeoIPInfoView(
            available=False,
            db_path=str(path),
            build_date=None,
            age_days=None,
        ),
    )


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


def test_health_degraded_when_services_paused_even_with_ingestion_disabled(monkeypatch):
    """The incident case: a UI head (LOGPARSER_ENABLED=false) whose startup
    probe failed. The database answers now, but nothing DB-bound is running."""
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("LOGPARSER_ENABLED", "false")

    app = make_app()
    app.state.db_available = False
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["database"] == {"reachable": True, "servicesActive": False}


def test_health_services_active_defaults_true_before_startup(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
    assert body["database"]["servicesActive"] is True


def test_health_includes_registry_advisories_critical_first(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    from geometrikks.lib.advisories import Advisory
    from geometrikks.server import runtime, timescale
    monkeypatch.setattr(timescale, "_hostname_pollution", None)

    app = make_app()
    runtime.get_advisories(app).set(Advisory(id="w", severity="warning", summary="w"))
    runtime.get_advisories(app).set(Advisory(id="c", severity="critical", summary="c"))
    with TestClient(app=app) as client:
        body = client.get("/health").json()
    assert [a["id"] for a in body["advisories"]] == ["c", "w"]


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


def test_health_reports_policy_update_failures(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    from geometrikks.server import timescale
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    monkeypatch.setattr(
        timescale,
        "_policy_failures",
        [
            timescale.PolicyFailure("retention", "geo_events", "boom"),
            timescale.PolicyFailure("compression", "access_logs", "boom"),
        ],
    )

    with TestClient(app=make_app()) as client:
        advisories = client.get("/health").json()["advisories"]

    [advisory] = [
        item for item in advisories if item["id"] == "timescale-policy-update-failed"
    ]
    assert advisory == {
        "id": "timescale-policy-update-failed",
        "severity": "warning",
        "summary": (
            "2 TimescaleDB policies could not be updated to match the current settings: "
            "retention on geo_events, compression on access_logs; the previous intervals "
            "stay in force."
        ),
        "detail": (
            "The app retries the updates at the next startup; check the app log for "
            "policy_update_failed before restarting."
        ),
        "remedy": None,
        "docsUrl": None,
    }


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


def test_health_exposes_write_failures_and_advises(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True

    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    from geometrikks.server import timescale

    monkeypatch.setattr(timescale, "_hostname_pollution", None)

    app = make_app()
    service = _running_service(file_missing=False)
    service.failed_batches = 2
    service.failed_records = 37
    app.state.ingestion_service = service
    with TestClient(app=app) as client:
        body = client.get("/health").json()

    assert body["ingestion"]["failedBatches"] == 2
    assert body["ingestion"]["failedRecords"] == 37
    [advisory] = [
        item for item in body["advisories"]
        if item["id"] == "ingestion-write-failures"
    ]
    assert "2 batches (37 records)" in advisory["summary"]
    assert "continues ingestion" in advisory["detail"]
    assert "ingestion_batch_failed" in advisory["detail"]


def _asn_advisories(app_state_asn: bool, asn_enabled: bool) -> list:
    from geometrikks.config.settings import Settings
    from geometrikks.domain.system.controllers.health import _collect_advisories

    settings = Settings()
    settings.geoip.asn_enabled = asn_enabled
    app = SimpleNamespace(
        state=SimpleNamespace(geoip_available=True, asn_available=app_state_asn)
    )
    return [a for a in _collect_advisories(cast("Any", app), settings) if a.id == "asn-database-missing"]


def test_asn_advisory_emitted_when_enabled_but_unavailable():
    advisories = _asn_advisories(app_state_asn=False, asn_enabled=True)
    assert len(advisories) == 1
    assert advisories[0].severity == "warning"
    assert "GEOIP_ASN_ENABLED=false" in (advisories[0].remedy or "")


def test_asn_advisory_absent_when_available():
    assert _asn_advisories(app_state_asn=True, asn_enabled=True) == []


def test_asn_advisory_absent_when_disabled():
    assert _asn_advisories(app_state_asn=False, asn_enabled=False) == []


def test_health_reports_asn_state(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)

    with TestClient(app=make_app()) as client:
        body = client.get("/health").json()
        assert isinstance(body["geoip"]["asnAvailable"], bool)
        assert "asnDbBuildDate" in body["geoip"]


def test_health_reports_a_failing_proxy_scan(monkeypatch):
    async def db_up(app, timeout: float = 2.0) -> bool:
        return True
    monkeypatch.setattr(health_module, "_database_reachable", db_up)
    monkeypatch.setenv("APP_PROXY_ADVISORY", "true")
    from geometrikks.domain.system import proxy_scan
    from geometrikks.server import timescale
    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    monkeypatch.setattr(proxy_scan, "_last_error", "db down")

    with TestClient(app=make_app()) as client:
        [a] = [x for x in client.get("/health").json()["advisories"] if x["id"] == "proxy-scan-failed"]
    detail = a["detail"]
    assert "db down" in detail
    assert "previous proxy findings remain visible" in detail
    assert "scheduled scans retry" in detail
    assert "proxy-peer-scan" in detail
    assert "Scheduler" in detail
    assert "app logs" in detail


def _stale_view(age_days: int | None, *, available: bool | None = None):
    from geometrikks.lib.utils import GeoIPInfoView

    return GeoIPInfoView(
        available=age_days is not None if available is None else available,
        db_path="x",
        build_date=None,
        age_days=age_days,
    )


def _geoip_advisories(
    monkeypatch: pytest.MonkeyPatch,
    *,
    city_age_days: int | None,
    credentials: bool,
    asn_enabled: bool = False,
    asn_age_days: int | None = None,
    scheduler_enabled: bool = True,
    refresh_days: int = 7,
    city_available: bool | None = None,
):
    from geometrikks.config.settings import Settings
    from geometrikks.domain.system.controllers.health import _collect_advisories
    from geometrikks.server import timescale

    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    monkeypatch.setattr(
        health_module,
        "geoip_info",
        lambda path: _stale_view(
            asn_age_days if path == settings.geoip.asn_db_path else city_age_days,
            available=(
                None if path == settings.geoip.asn_db_path else city_available
            ),
        ),
    )
    monkeypatch.setattr(
        health_module,
        "has_credentials",
        lambda geoip_settings: credentials,
    )
    settings = Settings()
    settings.geoip.asn_enabled = asn_enabled
    settings.geoip.refresh_days = refresh_days
    settings.scheduler.enabled = scheduler_enabled
    settings.app.proxy_advisory = False
    app = SimpleNamespace(
        state=SimpleNamespace(geoip_available=True, asn_available=asn_enabled)
    )
    return [
        advisory
        for advisory in _collect_advisories(cast("Any", app), settings)
        if advisory.id.endswith("-database-stale")
    ]


def test_geoip_database_is_fresh_at_exact_refresh_window(monkeypatch):
    assert _geoip_advisories(
        monkeypatch,
        city_age_days=30,
        credentials=False,
    ) == []


def test_geoip_database_is_stale_after_refresh_window_without_credentials(
    monkeypatch,
):
    [advisory] = _geoip_advisories(
        monkeypatch,
        city_age_days=31,
        credentials=False,
    )

    assert advisory.id == "geoip-database-stale"
    assert advisory.severity == "warning"
    assert "31 days old" in advisory.summary
    assert "no MaxMind credentials" in advisory.summary
    assert advisory.summary.count(".") == 1
    assert advisory.detail is not None and "30 days" in advisory.detail
    assert "every 7 days" in advisory.detail
    assert "geoip-refresh" in advisory.detail
    assert "restart" in advisory.detail
    assert advisory.remedy == "MAXMINDDB_USER_ID and MAXMINDDB_LICENSE_KEY"


def test_stale_geoip_database_with_credentials_reports_configured_cadence(
    monkeypatch,
):
    [advisory] = _geoip_advisories(
        monkeypatch,
        city_age_days=31,
        credentials=True,
        refresh_days=45,
    )

    assert "outside MaxMind's 30-day refresh window" in advisory.summary
    assert "not succeeding" not in advisory.summary
    assert advisory.summary.count(".") == 1
    assert advisory.detail is not None and "every 45 days" in advisory.detail
    assert "geoip-refresh" in advisory.detail
    assert "Settings > Scheduler" in advisory.detail
    assert "Run now" in advisory.detail
    assert "GEOIP_REFRESH_DAYS" in advisory.detail
    assert advisory.remedy == "GEOIP_REFRESH_DAYS=30"


def test_stale_geoip_database_with_credentials_when_scheduler_is_disabled(
    monkeypatch,
):
    [advisory] = _geoip_advisories(
        monkeypatch,
        city_age_days=45,
        credentials=True,
        scheduler_enabled=False,
        refresh_days=3,
    )

    assert "automatic refresh is disabled" in advisory.summary
    assert advisory.summary.count(".") == 1
    assert advisory.detail is not None and "restart" in advisory.detail
    assert "SCHEDULER_ENABLED=true" in advisory.detail
    assert "geoip-refresh job" not in advisory.detail


def test_stale_geoip_database_without_credentials_when_scheduler_is_disabled(
    monkeypatch,
):
    [advisory] = _geoip_advisories(
        monkeypatch,
        city_age_days=45,
        credentials=False,
        scheduler_enabled=False,
    )

    assert (
        advisory.detail is not None
        and "automatic refresh is disabled" in advisory.detail.lower()
    )
    manual_replace = advisory.detail.index("replace")
    manual_restart = advisory.detail.index("restart", manual_replace)
    assert manual_replace < manual_restart
    assert "credentials are not required" in advisory.detail.lower()
    automatic = advisory.detail.index("For automatic refresh")
    configure = advisory.detail.index("configure the credentials", automatic)
    enable = advisory.detail.index("SCHEDULER_ENABLED=true", configure)
    restart = advisory.detail.index("restart", enable)
    trigger = advisory.detail.index("Run now", restart)
    assert configure < enable < restart < trigger
    assert "Settings > Scheduler" in advisory.detail
    assert "next run" in advisory.detail
    assert "geoip-refresh job" not in advisory.detail
    assert advisory.remedy == "MAXMINDDB_USER_ID and MAXMINDDB_LICENSE_KEY"


@pytest.mark.parametrize(
    ("scheduler_enabled", "credentials"),
    [
        (True, True),
        (True, False),
        (False, True),
        (False, False),
    ],
)
def test_long_geoip_refresh_cadence_has_complete_automatic_recovery(
    monkeypatch,
    scheduler_enabled,
    credentials,
):
    [advisory] = _geoip_advisories(
        monkeypatch,
        city_age_days=31,
        credentials=credentials,
        scheduler_enabled=scheduler_enabled,
        refresh_days=45,
    )

    assert advisory.detail is not None
    automatic_start = advisory.detail.index("For automatic refresh")
    automatic = advisory.detail[automatic_start:]
    refresh_setting = automatic.index("GEOIP_REFRESH_DAYS to 30 or less")
    restart = automatic.index("restart")
    database_active = automatic.index("database services are active", restart)
    run_now = automatic.index("Run now", database_active)
    assert refresh_setting < restart < database_active < run_now
    assert "Settings > Scheduler" in automatic
    if not credentials:
        assert automatic.index("configure the credentials") < restart
    if not scheduler_enabled:
        assert automatic.index("SCHEDULER_ENABLED=true") < restart
        manual = advisory.detail[:automatic_start]
        assert manual.index("replace") < manual.index("restart")
    remedy = advisory.remedy or ""
    assert "GEOIP_REFRESH_DAYS=30" in remedy
    if not credentials:
        assert "MAXMINDDB_USER_ID" in remedy
        assert "MAXMINDDB_LICENSE_KEY" in remedy
    if not scheduler_enabled:
        assert "SCHEDULER_ENABLED=true" in remedy


def test_geoip_database_without_age_metadata_emits_no_stale_advisory(monkeypatch):
    assert _geoip_advisories(
        monkeypatch,
        city_age_days=None,
        credentials=False,
        city_available=True,
    ) == []


def test_stale_asn_database_gets_its_own_advisory_when_enabled(monkeypatch):
    advisories = _geoip_advisories(
        monkeypatch,
        city_age_days=31,
        credentials=True,
        asn_enabled=True,
        asn_age_days=31,
    )

    assert sorted(advisory.id for advisory in advisories) == [
        "asn-database-stale",
        "geoip-database-stale",
    ]


def test_stale_asn_database_is_ignored_when_disabled(monkeypatch):
    assert _geoip_advisories(
        monkeypatch,
        city_age_days=20,
        credentials=True,
        asn_enabled=False,
        asn_age_days=31,
    ) == []


def _listener_advisories(
    monkeypatch: pytest.MonkeyPatch,
    state: str | None,
    *,
    db_available: bool = True,
):
    from geometrikks.config.settings import Settings
    from geometrikks.domain.system.controllers.health import _collect_advisories
    from geometrikks.server import timescale

    monkeypatch.setattr(timescale, "_hostname_pollution", None)
    settings = Settings()
    settings.app.proxy_advisory = False
    app_state = SimpleNamespace(
        geoip_available=True,
        asn_available=True,
        db_available=db_available,
    )
    if state is not None:
        app_state.channels_backend = SimpleNamespace(state=state)
    app = SimpleNamespace(state=app_state)
    return [
        advisory
        for advisory in _collect_advisories(cast("Any", app), settings)
        if advisory.id == "live-feed-listener-down"
    ]


def test_listener_reconnecting_emits_advisory(monkeypatch):
    [advisory] = _listener_advisories(monkeypatch, "reconnecting")

    assert advisory.severity == "warning"
    assert advisory.summary.count(".") == 1
    assert "reconnects on its own" in (advisory.detail or "")


def test_listener_degraded_with_database_active_emits_advisory(monkeypatch):
    [advisory] = _listener_advisories(monkeypatch, "degraded")

    assert "receive no events" in advisory.summary


def test_listener_ok_or_absent_emits_no_advisory(monkeypatch):
    assert _listener_advisories(monkeypatch, "ok") == []
    assert _listener_advisories(monkeypatch, None) == []


def test_listener_advisory_is_suppressed_while_database_is_unavailable(monkeypatch):
    assert _listener_advisories(
        monkeypatch,
        "degraded",
        db_available=False,
    ) == []
