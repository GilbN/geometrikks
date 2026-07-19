"""System API: scheduler job listing, manual runs, redacted settings overview."""
from __future__ import annotations

from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from litestar import Litestar
from litestar.testing import AsyncTestClient

from geometrikks.api.v1.system_controller import SystemController
from geometrikks.server.scheduler_tracking import JobRunTracker

FUTURE = datetime(2030, 1, 1, tzinfo=timezone.utc)


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

    return Litestar(route_handlers=[SystemController], on_startup=[startup])


async def test_lists_jobs_with_run_info():
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/scheduler/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["scheduler_enabled"] is True
    assert len(body["jobs"]) == 1
    job = body["jobs"][0]
    assert job["id"] == "job-a"
    assert job["name"] == "Job A"
    assert job["next_run_time"] is not None
    assert job["running"] is False
    assert job["last_run_time"] is None
    assert job["last_status"] is None


async def test_no_scheduler_reports_disabled():
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        resp = await client.get("/api/v1/system/scheduler/jobs")
    assert resp.status_code == 200
    assert resp.json() == {
        "scheduler_enabled": False,
        "scheduler_running": False,
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
    assert body["runtime"]["python_version"]
    assert body["runtime"]["litestar_version"]
    assert body["runtime"]["apscheduler_version"]

    # Reported whether or not a database is reachable, never a 500. A local
    # dev database yields real versions; CI without one yields nulls.
    assert set(body["database"]) == {
        "postgres_version",
        "timescaledb_version",
        "postgis_version",
    }
    assert all(v is None or isinstance(v, str) for v in body["database"].values())

    # The test mmdb has real metadata
    assert body["geoip"]["available"] is True
    assert body["geoip"]["build_date"] is not None
    assert body["geoip"]["age_days"] is not None

    assert body["links"]["repository"] == "https://github.com/GilbN/geometrikks"
    assert body["links"]["issues"].endswith("/issues")


async def test_about_geoip_degrades_when_db_missing(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "does/not/exist.mmdb")
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    geoip = resp.json()["geoip"]
    assert geoip["available"] is False
    assert geoip["build_date"] is None


async def test_about_database_degrades_when_db_unreachable(monkeypatch):
    """An unreachable database must null the versions, never fail the page."""
    import geometrikks.server.plugins as plugins

    def boom():
        raise RuntimeError("no database")

    monkeypatch.setattr(plugins, "get_sqlalchemy_config", boom)
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    assert resp.json()["database"] == {
        "postgres_version": None,
        "timescaledb_version": None,
        "postgis_version": None,
    }
