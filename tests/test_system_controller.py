"""System API: scheduler job listing, manual runs, redacted settings overview."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx2
import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import Settings
from geometrikks.domain.analytics.asn_classification import hosting_asn_count
from geometrikks.domain.system import commit
from geometrikks.domain.system.controllers.system import SystemController
from geometrikks.server.scheduler_tracking import JobRunTracker
from geometrikks.services.release_check import ReleaseChecker
from geometrikks.server.schema_wait import bundled_head_revision, bundled_revision_doc
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

FUTURE = datetime.now(timezone.utc) + timedelta(days=365)


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


async def test_no_scheduler_reports_unavailable():
    """DB-degraded mode never starts the scheduler; the page must not blame
    SCHEDULER_ENABLED=false for that."""
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        resp = await client.get("/api/v1/system/scheduler/jobs")
    assert resp.status_code == 200
    assert resp.json() == {
        "schedulerEnabled": False,
        "schedulerRunning": False,
        "jobs": [],
        "status": "unavailable",
    }


async def test_no_scheduler_reports_unavailable_when_configured_disabled(monkeypatch):
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        body = (await client.get("/api/v1/system/scheduler/jobs")).json()
    assert body["status"] == "unavailable"


async def test_running_scheduler_reports_status_running():
    async with AsyncTestClient(app=make_app()) as client:
        body = (await client.get("/api/v1/system/scheduler/jobs")).json()
    assert body["status"] == "running"


async def test_scheduler_disabled_by_settings_reports_status_disabled(monkeypatch):
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    async with AsyncTestClient(app=make_app()) as client:
        body = (await client.get("/api/v1/system/scheduler/jobs")).json()
    assert body["status"] == "disabled"
    assert body["schedulerEnabled"] is False


async def test_disabled_scheduler_stays_unstarted_and_detaches_on_shutdown(monkeypatch):
    from geometrikks.server import lifecycle as lc

    settings = Settings(scheduler={"enabled": False})
    monkeypatch.setattr(
        lc,
        "get_app_db_config",
        lambda _app: SimpleNamespace(create_session_maker=lambda: object()),
    )

    async def startup(app: Litestar) -> None:
        app.state.settings = settings
        await lc.start_scheduler(app)

    async def shutdown(app: Litestar) -> None:
        await lc.stop_scheduler(app)

    app = Litestar(
        route_handlers=[create_api_v1_router([SystemController])],
        on_startup=[startup],
        on_shutdown=[shutdown],
        dependencies={
            "settings": Provide(lambda: settings, sync_to_thread=False),
            "db_engine": Provide(UnreachableEngine, sync_to_thread=False),
        },
    )

    async with AsyncTestClient(app=app) as client:
        scheduler = app.state.scheduler
        body = (await client.get("/api/v1/system/scheduler/jobs")).json()
        assert scheduler.running is False
        assert scheduler.get_jobs() == []
        assert not hasattr(app.state, "scheduler_tracker")
        assert body == {
            "schedulerEnabled": False,
            "schedulerRunning": False,
            "jobs": [],
            "status": "disabled",
        }

    assert not hasattr(app.state, "scheduler")
    assert not hasattr(app.state, "scheduler_tracker")


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

    from geometrikks.services.geoip.self_location import SelfLocation

    async def startup(app: Litestar) -> None:
        app.state.self_location = SelfLocation(
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

    lat = field("map", "server_latitude")
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


async def test_system_settings_no_computed_server_location_when_absent():
    # make_app() seeds no self_location and no geoip_available.
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/settings")
    sections = {s["name"]: s for s in resp.json()["sections"]}
    lat = next(f for f in sections["map"]["fields"] if f["key"] == "server_latitude")
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
    assert bundled_revision_doc("18be2778bd7c") == "rename hostname columns and site_homes to server"
    head_doc = bundled_revision_doc(bundled_head_revision())
    assert head_doc is not None
    assert head_doc.strip()
    assert bundled_revision_doc("ffffffffffff") is None


RELEASE_PUBLISHED_AT = "2026-10-01T08:00:00Z"
RELEASE_CHECKED_AT = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)


def release_transport(
    *tags: str, prerelease: bool = False, status_code: int = 200
) -> httpx2.MockTransport:
    body = [
        {
            "tag_name": tag,
            "draft": False,
            "prerelease": prerelease,
            "html_url": f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
            "published_at": RELEASE_PUBLISHED_AT,
        }
        for tag in tags
    ]
    return httpx2.MockTransport(
        lambda request: httpx2.Response(status_code, content=json.dumps(body).encode())
    )


async def seeded_release_checker(
    running_version: str, transport: httpx2.AsyncBaseTransport
) -> ReleaseChecker:
    release_checker = ReleaseChecker(
        running_version, transport=transport, clock=lambda: RELEASE_CHECKED_AT
    )
    await release_checker.run()
    return release_checker


def enable_release_check(monkeypatch: pytest.MonkeyPatch, version: str = "0.22.0") -> None:
    monkeypatch.setenv("APP_UPDATE_CHECK", "true")
    monkeypatch.setattr("geometrikks.config.settings.get_installed_version", lambda: version)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("APP_UPDATE_CHECK", "false"),
        ("SCHEDULER_ENABLED", "false"),
        ("version", "0.0.0+local"),
        ("version", "custom"),
    ],
)
async def test_release_check_off_when_disabled(monkeypatch, name, value):
    if name == "version":
        enable_release_check(monkeypatch, version=value)
    else:
        enable_release_check(monkeypatch)
        monkeypatch.setenv(name, value)
    app = make_app()
    app.state.release_checker = await seeded_release_checker(
        "0.22.0", release_transport("v0.23.0")
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/release-check")
    assert resp.status_code == 200
    assert resp.json() == {"status": "off", "latest": None, "checkedAt": None}


async def test_release_check_pending_before_the_first_success(monkeypatch):
    enable_release_check(monkeypatch)
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/release-check")
    assert resp.status_code == 200
    assert resp.json() == {"status": "pending", "latest": None, "checkedAt": None}

    def time_out(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectTimeout("timed out", request=request)

    app = make_app()
    app.state.release_checker = await seeded_release_checker(
        "0.22.0", httpx2.MockTransport(time_out)
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/release-check")
    assert resp.json() == {"status": "pending", "latest": None, "checkedAt": None}


async def test_release_check_checked_with_nothing_newer(monkeypatch):
    enable_release_check(monkeypatch)
    app = make_app()
    app.state.release_checker = await seeded_release_checker(
        "0.22.0", release_transport("v0.22.0")
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/release-check")
    body = resp.json()
    assert body["status"] == "checked"
    assert body["latest"] is None
    assert datetime.fromisoformat(body["checkedAt"]) == RELEASE_CHECKED_AT


async def test_release_check_checked_with_a_newer_release(monkeypatch):
    enable_release_check(monkeypatch)
    app = make_app()
    app.state.release_checker = await seeded_release_checker(
        "0.22.0", release_transport("v0.23.0")
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/release-check")
    body = resp.json()
    assert body["status"] == "checked"
    latest = body["latest"]
    assert datetime.fromisoformat(latest.pop("publishedAt")) == datetime.fromisoformat(
        RELEASE_PUBLISHED_AT
    )
    assert latest == {
        "version": "0.23.0",
        "displayVersion": "v0.23.0",
        "url": "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0",
    }


async def test_release_check_dev_release_uses_tag_style(monkeypatch):
    enable_release_check(monkeypatch, "0.22.1.dev1")
    app = make_app()
    app.state.release_checker = await seeded_release_checker(
        "0.22.1.dev1", release_transport("v0.22.1-dev.2", prerelease=True)
    )
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/release-check")
    latest = resp.json()["latest"]
    assert latest["version"] == "0.22.1.dev2"
    assert latest["displayVersion"] == "v0.22.1-dev.2"
