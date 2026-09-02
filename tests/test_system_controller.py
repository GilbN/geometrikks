"""System API: scheduler job listing, manual runs, redacted settings overview."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.analytics.asn_classification import hosting_asn_count
from geometrikks.domain.system import commit
from geometrikks.domain.system.controllers.system import SystemController
from geometrikks.server.scheduler_tracking import JobRunTracker
from geometrikks.server.schema_wait import bundled_head_revision, bundled_revision_doc
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

FUTURE = datetime(2030, 1, 1, tzinfo=timezone.utc)


class UnreachableEngine:
    """db_engine stand-in whose connections always fail (DB-degraded mode).

    The real provider hands out the engine without connecting, so an
    unreachable database surfaces at query time; this stub fails at the
    same point.
    """

    def connect(self):
        raise RuntimeError("database unavailable")


async def noop() -> None:
    """Job target for tests; never actually runs."""


def make_app(*, with_scheduler: bool = True) -> Litestar:
    async def startup(app: Litestar) -> None:
        if not with_scheduler:
            return
        scheduler = AsyncIOScheduler(timezone=timezone.utc)
        scheduler.start(paused=True)
        scheduler.add_job(
            noop,
            IntervalTrigger(minutes=5),
            id="job-a",
            name="Job A",
            next_run_time=FUTURE,
        )
        tracker = JobRunTracker()
        tracker.attach(scheduler)
        app.state.scheduler = scheduler
        app.state.scheduler_tracker = tracker

    return Litestar(
        route_handlers=[create_api_v1_router([SystemController])],
        on_startup=[startup],
        dependencies={
            **ambient_settings_dependency(),
            "db_engine": Provide(UnreachableEngine, sync_to_thread=False),
        },
    )


async def test_lists_jobs_with_run_info():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/scheduler/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["schedulerEnabled"] is True
    assert len(body["jobs"]) == 1
    job = body["jobs"][0]
    assert job["id"] == "job-a"
    assert job["name"] == "Job A"
    assert job["nextRunTime"] is not None
    assert job["running"] is False
    assert job["lastRunTime"] is None
    assert job["lastStatus"] is None


async def test_no_scheduler_reports_disabled():
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        resp = await client.get("/api/v1/system/scheduler/jobs")
    assert resp.status_code == 200
    assert resp.json() == {
        "schedulerEnabled": False,
        "schedulerRunning": False,
        "jobs": [],
    }


async def test_run_now_moves_next_run_time():
    app = make_app()
    async with AsyncTestClient(app=app) as client:
        resp = await client.post("/api/v1/system/scheduler/jobs/job-a/run")
        assert resp.status_code == 202
        assert resp.json()["id"] == "job-a"
        job = app.state.scheduler.get_job("job-a")
        assert job.next_run_time < FUTURE


async def test_run_unknown_job_returns_404():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.post("/api/v1/system/scheduler/jobs/nope/run")
    assert resp.status_code == 404


async def test_system_settings_never_leak_secrets(monkeypatch):
    monkeypatch.setenv("DB_PASSWORD", "super-secret-db-pass")
    monkeypatch.setenv("MAXMINDDB_LICENSE_KEY", "maxmind-secret-key")
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "admin-secret-pass")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/settings")
    assert resp.status_code == 200
    for secret in ("super-secret-db-pass", "maxmind-secret-key", "admin-secret-pass"):
        assert secret not in resp.text
    body = resp.json()
    assert [s["name"] for s in body["sections"]][0] == "app"


async def test_about_reports_app_runtime_and_geoip_metadata(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "tests/GeoLite2-City-Test.mmdb")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    body = resp.json()

    assert body["app"]["name"]
    assert body["app"]["version"]
    assert body["runtime"]["pythonVersion"]
    assert body["runtime"]["litestarVersion"]
    assert body["runtime"]["apschedulerVersion"]

    # Reported whether or not a database is reachable, never a 500. A local
    # dev database yields real versions; CI without one yields nulls.
    assert set(body["database"]) == {
        "postgresVersion",
        "timescaledbVersion",
        "postgisVersion",
        "migrationRevision",
        "migrationName",
        "migrationHead",
    }
    assert all(v is None or isinstance(v, str) for v in body["database"].values())

    # The test mmdb has real metadata
    assert body["geoip"]["available"] is True
    assert body["geoip"]["buildDate"] is not None
    assert body["geoip"]["ageDays"] is not None

    assert body["links"]["repository"] == "https://github.com/GilbN/geometrikks"
    assert body["links"]["issues"].endswith("/issues")


async def test_about_reports_asn_classification_provenance():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    meta = resp.json()["asnClassification"]
    assert meta["dataset"] == "bad-asn-list"
    assert meta["entries"] == hosting_asn_count()
    assert meta["license"] == "MIT"
    assert meta["sourceUrl"].startswith("https://github.com/")


async def test_asn_classification_list_matches_loader():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/asn-classification")
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset"] == "bad-asn-list"
    assert body["sourceUrl"].startswith("https://github.com/")
    entries = body["entries"]
    assert len(entries) == hosting_asn_count()
    asns = [e["asn"] for e in entries]
    assert asns == sorted(asns)
    assert len(set(asns)) == len(asns)
    amazon = next(e for e in entries if e["asn"] == 16509)
    assert "Amazon" in amazon["entity"]


async def test_about_geoip_degrades_when_db_missing(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "does/not/exist.mmdb")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    geoip = resp.json()["geoip"]
    assert geoip["available"] is False
    assert geoip["buildDate"] is None


async def test_about_database_degrades_when_db_unreachable():
    """An unreachable database must null the versions, never fail the page.

    make_app() provides the UnreachableEngine db_engine stub, failing at
    connect time exactly like a real engine with the database down."""
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    assert resp.json()["database"] == {
        "postgresVersion": None,
        "timescaledbVersion": None,
        "postgisVersion": None,
        "migrationRevision": None,
        "migrationName": None,
        "migrationHead": bundled_head_revision(),
    }


async def test_system_settings_surface_computed_values(monkeypatch):
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://localhost:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "bouncer-key")

    from geometrikks.services.geoip.home import HomeLocation

    async def startup(app: Litestar) -> None:
        app.state.map_home_location = HomeLocation(
            latitude=59.91, longitude=10.75, source="external_ip"
        )
        app.state.geoip_available = True

    app = Litestar(
        route_handlers=[create_api_v1_router([SystemController])],
        on_startup=[startup],
        dependencies={
            **ambient_settings_dependency(),
            "db_engine": Provide(UnreachableEngine, sync_to_thread=False),
        },
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/settings")
    assert resp.status_code == 200
    sections = {s["name"]: s for s in resp.json()["sections"]}

    def field(section: str, key: str) -> dict:
        return next(f for f in sections[section]["fields"] if f["key"] == key)

    lat = field("map", "home_latitude")
    assert lat["value"] is None
    assert lat["computedValue"] == 59.91
    assert lat["computedSource"] == "external_ip"

    avail = field("geoip", "available")
    assert avail["computedValue"] is True
    assert avail["computedSource"] == "runtime"
    assert avail["envVar"] is None

    enabled = field("crowdsec", "enabled")
    assert enabled["computedValue"] is True
    assert enabled["computedSource"] == "runtime"


async def test_system_settings_no_computed_home_when_absent():
    # make_app() seeds no map_home_location and no geoip_available.
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/settings")
    sections = {s["name"]: s for s in resp.json()["sections"]}
    lat = next(f for f in sections["map"]["fields"] if f["key"] == "home_latitude")
    assert lat["computedValue"] is None

    avail = next(f for f in sections["geoip"]["fields"] if f["key"] == "available")
    assert avail["computedValue"] is False
    assert avail["computedSource"] == "runtime"


async def test_database_info_degraded_without_db():
    """/system/database renders nulls (not 500) when the DB is unreachable."""
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        resp = await client.get("/api/v1/system/database")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reachable"] is False
    assert body["sizeBytes"] is None
    assert body["postgresVersion"] is None
    assert body["timescaledbVersion"] is None
    assert isinstance(body["retentionDays"], int)
    assert isinstance(body["debugRetentionDays"], int)
    assert body["hypertables"] == []


async def test_about_reports_bundled_migration_head_when_db_unreachable(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "tests/GeoLite2-City-Test.mmdb")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    database = resp.json()["database"]
    assert database["migrationRevision"] is None
    assert database["migrationName"] is None
    assert database["migrationHead"] == bundled_head_revision()


async def test_about_carries_the_build_commit(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "tests/GeoLite2-City-Test.mmdb")
    monkeypatch.setattr(commit, "resolve_commit", lambda: "0123456789abcdef0123456789abcdef01234567")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    assert resp.json()["app"]["commit"] == "0123456789abcdef0123456789abcdef01234567"


def test_bundled_revision_doc_is_the_migration_message():
    head = bundled_head_revision()
    assert bundled_revision_doc(head) == "widen HTTP method columns for the IANA registry"
    assert bundled_revision_doc("ffffffffffff") is None
