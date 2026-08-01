"""System API: scheduler job listing, manual runs, redacted settings overview."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from litestar import Litestar
from litestar.testing import AsyncTestClient

from geometrikks.api.v1.system_controller import SystemController
from geometrikks.server.scheduler_tracking import JobRunTracker

FUTURE = datetime(2030, 1, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
async def _dispose_cached_db_engine():
    """Dispose the process-cached engine on the loop that used it.

    The /about tests may open a real pooled asyncpg connection through the
    lru_cached SQLAlchemy config. Each test runs on its own event loop, so a
    pooled connection left behind outlives its loop; when asyncpg later
    finalizes it, the close-timeout path leaks an unawaited
    Connection._cancel coroutine (RuntimeWarning). Disposing before the loop
    closes keeps every connection loop-local.
    """
    yield
    from geometrikks.server import plugins

    config_factory = plugins.get_sqlalchemy_config
    cache_info = getattr(config_factory, "cache_info", None)
    if cache_info is None or cache_info().currsize == 0:
        return
    await config_factory().get_engine().dispose()
    config_factory.cache_clear()


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


async def test_system_settings_surface_computed_values(monkeypatch):
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://localhost:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "bouncer-key")

    from geometrikks.services.geoip.home import HomeLocation

    async def startup(app: Litestar) -> None:
        app.state.map_home_location = HomeLocation(
            latitude=59.91, longitude=10.75, source="external_ip"
        )
        app.state.geoip_available = True

    app = Litestar(route_handlers=[SystemController], on_startup=[startup])
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/system/settings")
    assert resp.status_code == 200
    sections = {s["name"]: s for s in resp.json()["sections"]}

    def field(section: str, key: str) -> dict:
        return next(f for f in sections[section]["fields"] if f["key"] == key)

    lat = field("map", "home_latitude")
    assert lat["value"] is None
    assert lat["computed_value"] == 59.91
    assert lat["computed_source"] == "external_ip"

    avail = field("geoip", "available")
    assert avail["computed_value"] is True
    assert avail["computed_source"] == "runtime"
    assert avail["env_var"] is None

    enabled = field("crowdsec", "enabled")
    assert enabled["computed_value"] is True
    assert enabled["computed_source"] == "runtime"


async def test_system_settings_no_computed_home_when_absent():
    # make_app() seeds no map_home_location and no geoip_available.
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/settings")
    sections = {s["name"]: s for s in resp.json()["sections"]}
    lat = next(f for f in sections["map"]["fields"] if f["key"] == "home_latitude")
    assert lat["computed_value"] is None

    avail = next(f for f in sections["geoip"]["fields"] if f["key"] == "available")
    assert avail["computed_value"] is False
    assert avail["computed_source"] == "runtime"


async def test_database_info_degraded_without_db(monkeypatch):
    """/system/database renders nulls (not 500) when the DB is unreachable."""
    def no_db():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("geometrikks.server.plugins.get_sqlalchemy_config", no_db)
    async with AsyncTestClient(app=make_app(with_scheduler=False)) as client:
        resp = await client.get("/api/v1/system/database")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reachable"] is False
    assert body["size_bytes"] is None
    assert body["postgres_version"] is None
    assert body["timescaledb_version"] is None
    assert isinstance(body["retention_days"], int)
    assert isinstance(body["debug_retention_days"], int)
    assert body["hypertables"] == []
