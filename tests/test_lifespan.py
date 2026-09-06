"""Lifespan managers: teardown ordering, partial-failure unwind, degraded mode."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.support import enter_lifespan
from tests.test_lifecycle_geoip import _patch_startup_collaborators

pytestmark = pytest.mark.anyio


def _enable_crowdsec(monkeypatch) -> None:
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")


def _patch_crowdsec_service(monkeypatch, lc) -> MagicMock:
    service = MagicMock()
    service.aclose = AsyncMock()
    monkeypatch.setattr(lc, "CrowdSecService", MagicMock(return_value=service))
    monkeypatch.setattr(lc, "CrowdSecStreamPoller", MagicMock())
    return service


async def test_teardown_runs_in_reverse_startup_order(monkeypatch):
    """Ingestion stops before the scheduler, which stops before the CrowdSec
    client closes: nothing keeps writing or polling during teardown."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    order: list[str] = []
    service = _patch_crowdsec_service(monkeypatch, lc)
    service.aclose = AsyncMock(side_effect=lambda: order.append("crowdsec"))
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.running = True
    scheduler.shutdown = MagicMock(side_effect=lambda wait=True: order.append("scheduler"))
    ingestion.stop = AsyncMock(side_effect=lambda timeout=None: order.append("ingestion"))

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        assert order == []

    assert order == ["ingestion", "scheduler", "crowdsec"]


async def test_core_state_lifespan_initializes_advisory_registry():
    from geometrikks.lib.advisories import AdvisoryRegistry
    from geometrikks.server import lifecycle as lc

    app = SimpleNamespace(state=SimpleNamespace())
    async with lc.core_state_lifespan(cast("Any", app)):
        assert isinstance(app.state.advisories, AdvisoryRegistry)


async def test_startup_failure_unwinds_started_managers(monkeypatch):
    """A migration failure fails startup, but the CrowdSec client the earlier
    manager already opened must still be closed (partial-startup cleanup)."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    service = _patch_crowdsec_service(monkeypatch, lc)
    monkeypatch.setattr(lc, "migrate_database", AsyncMock(side_effect=RuntimeError("boom")))

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="boom"):
        async with enter_lifespan(app):
            pass  # pragma: no cover - startup fails before the body runs

    service.aclose.assert_awaited_once()
    # The failure happened before the scheduler and ingestion managers entered.
    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_crowdsec_wiring_failure_still_closes_client(monkeypatch):
    """If setup fails after the LAPI client exists (poller construction),
    the manager's own cleanup must close the client."""
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    service = _patch_crowdsec_service(monkeypatch, lc)
    monkeypatch.setattr(
        lc, "CrowdSecStreamPoller", MagicMock(side_effect=RuntimeError("poller boom"))
    )

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="poller boom"):
        async with enter_lifespan(app):
            pass

    service.aclose.assert_awaited_once()


async def test_scheduler_start_failure_still_shuts_down(monkeypatch):
    """If start() activates the scheduler and then raises, the running
    scheduler must still be shut down; ingestion never starts."""
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.start = MagicMock(side_effect=RuntimeError("job store down"))
    scheduler.running = True

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="job store down"):
        async with enter_lifespan(app):
            pass

    scheduler.shutdown.assert_called_once_with(wait=True)
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_ingestion_start_failure_still_stops_service(monkeypatch):
    """If start() activates tailers and then raises, the partially started
    service must still be stopped."""
    from geometrikks.server import lifecycle as lc

    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    ingestion.start = AsyncMock(side_effect=RuntimeError("tailer exploded"))

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="tailer exploded"):
        async with enter_lifespan(app):
            pass

    ingestion.stop.assert_awaited_once()
    assert not hasattr(app.state, "ingestion_service")
    await lc.stop_ingestion(cast("Any", app))
    ingestion.stop.assert_awaited_once()


async def test_db_degraded_mode_skips_scheduler_and_ingestion(monkeypatch):
    """DB-degraded mode serves the API but never starts DB-bound services."""
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        assert app.state.db_available is False
        assert not hasattr(app.state, "scheduler")
        assert not hasattr(app.state, "ingestion_service")

    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_degraded_start_registers_advisory_and_defers_the_poller(monkeypatch):
    from geometrikks.server import lifecycle as lc
    from geometrikks.server import runtime

    _enable_crowdsec(monkeypatch)
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    _patch_crowdsec_service(monkeypatch, lc)
    poller = cast("MagicMock", lc.CrowdSecStreamPoller).return_value

    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        assert app.state.db_available is False
        assert app.state.db_degraded_since is not None
        assert app.state.crowdsec_stream_poller is None
        assert app.state.crowdsec_stream_poller_deferred is poller
        ids = [a.id for a in runtime.get_advisories(cast("Any", app)).snapshot()]
        # Membership, not equality: geoip_lifespan may register the
        # map-home advisory too (Task 16).
        assert "database-unavailable" in ids


async def test_stop_functions_are_no_ops_without_state():
    from geometrikks.server import lifecycle as lc

    app = SimpleNamespace(state=SimpleNamespace())
    await lc.stop_scheduler(cast("Any", app))
    await lc.stop_ingestion(cast("Any", app))
    await lc.stop_scheduler(cast("Any", app))
    await lc.stop_ingestion(cast("Any", app))


async def test_start_scheduler_attaches_state_before_start(monkeypatch):
    """A start() that raises after activating the scheduler must leave it on
    state so stop_scheduler can shut it down."""
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.start = MagicMock(side_effect=RuntimeError("job store down"))
    scheduler.running = True

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(RuntimeError, match="job store down"):
        await lc.start_scheduler(cast("Any", app))
    assert app.state.scheduler is scheduler
    await lc.stop_scheduler(cast("Any", app))
    scheduler.shutdown.assert_called_once_with(wait=True)
    assert not hasattr(app.state, "scheduler")
    assert not hasattr(app.state, "scheduler_tracker")
    await lc.stop_scheduler(cast("Any", app))
    scheduler.shutdown.assert_called_once_with(wait=True)


async def test_stop_scheduler_waits_for_real_shutdown_before_detaching():
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    from geometrikks.server import lifecycle as lc

    scheduler = AsyncIOScheduler()
    scheduler.start()
    app = SimpleNamespace(
        state=SimpleNamespace(scheduler=scheduler, scheduler_tracker=object())
    )

    await asyncio.wait_for(lc.stop_scheduler(cast("Any", app)), timeout=2.0)

    assert scheduler.running is False
    assert not hasattr(app.state, "scheduler")
    assert not hasattr(app.state, "scheduler_tracker")


async def test_cancelled_ingestion_stop_retains_handle_for_later_cleanup(
    monkeypatch, tmp_path
):
    from geometrikks.server import lifecycle as lc
    from geometrikks.services.ingestion import service as ingestion_module
    from tests.test_ingestion import make_parser, make_service

    log_path = tmp_path / "stuck.log"
    log_path.write_text("", encoding="utf-8")
    parser = make_parser(log_path)
    tail_started = asyncio.Event()
    release_tail = asyncio.Event()

    async def stuck_records(*args, **kwargs):
        tail_started.set()
        await release_tail.wait()
        if False:
            yield None

    monkeypatch.setattr(parser, "iter_parsed_records", stuck_records)
    service, _repos, _sessions = make_service([parser])
    await service.start(skip_validation=True)
    await asyncio.wait_for(tail_started.wait(), timeout=1.0)

    wait_entered = asyncio.Event()
    real_wait = asyncio.wait

    async def observed_wait(*args, **kwargs):
        wait_entered.set()
        return await real_wait(*args, **kwargs)

    monkeypatch.setattr(ingestion_module.asyncio, "wait", observed_wait)
    app = SimpleNamespace(state=SimpleNamespace(ingestion_service=service))
    first_stop = asyncio.create_task(lc.stop_ingestion(cast("Any", app)))
    await asyncio.wait_for(wait_entered.wait(), timeout=1.0)
    first_stop.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_stop

    assert app.state.ingestion_service is service
    assert any(not task.done() for task in service._tail_tasks)

    release_tail.set()
    await asyncio.wait_for(lc.stop_ingestion(cast("Any", app)), timeout=1.0)

    assert all(task.done() for task in service._tail_tasks)
    assert not service.is_task_running
    assert not hasattr(app.state, "ingestion_service")


async def test_agent_mode_waits_for_schema_and_skips_crowdsec(monkeypatch):
    """Agent mode never migrates or manages TimescaleDB objects -- it waits
    for the primary instance's schema instead -- and never wires CrowdSec."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    wait_for_schema = AsyncMock(return_value="ready")
    monkeypatch.setattr(lc, "wait_for_schema", wait_for_schema)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    wait_for_schema.assert_awaited_once()
    cast("AsyncMock", lc.migrate_database).assert_not_awaited()
    cast("AsyncMock", lc.setup_timescaledb).assert_not_awaited()
    assert app.state.db_available is True
    assert app.state.schema_wait_result == "ready"
    assert app.state.crowdsec_service is None
    assert app.state.crowdsec_stream_poller is None


async def test_agent_mode_schema_timeout_is_db_degraded(monkeypatch):
    """A schema wait that never reaches ready/newer degrades like an
    unreachable database: no scheduler, no ingestion."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="timeout"))

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert app.state.db_available is False
        assert app.state.schema_wait_result == "timeout"

    cast("AsyncMock", lc.create_scheduler).assert_not_awaited()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_ingestion_disabled_by_config_skips_construction(monkeypatch):
    """LOGPARSER_ENABLED=false no-ops ingestion without building parsers or
    the service -- mirrors the DB-degraded no-op path. /health tells
    "disabled by configuration" apart from degraded by reading
    settings.logparser.enabled directly."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_ENABLED", "false")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert not hasattr(app.state, "ingestion_service")

    cast("MagicMock", lc.LogParser).assert_not_called()
    cast("MagicMock", lc.LogIngestionService).assert_not_called()


async def test_agent_schema_ready_triggers_home_upsert(monkeypatch):
    """A successful schema wait records this agent's detected home for each
    hostname it tails."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="ready"))
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    upsert.assert_awaited_once()
    assert upsert.await_args is not None
    hostnames = upsert.await_args.args[1]
    assert hostnames == Settings().logparser.resolved_hostnames()


async def test_agent_schema_timeout_skips_home_upsert(monkeypatch):
    """A timed-out schema wait leaves site_homes untouched: the agent is
    already going degraded, there is nothing trustworthy to record."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("APP_MODE", "agent")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="timeout"))
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    upsert.assert_not_awaited()


async def test_full_startup_reconciles_overrides_and_upserts(monkeypatch):
    """A primary instance always reconciles MAP_HOME_LOCATIONS overrides and,
    when it also tails logs, records its own auto-detected home."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    reconcile = AsyncMock()
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "reconcile_override_homes", reconcile)
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    reconcile.assert_awaited_once()
    upsert.assert_awaited_once()


async def test_ui_head_reconciles_but_does_not_upsert(monkeypatch):
    """LOGPARSER_ENABLED=false tails nothing under its own hostname, so it
    still reconciles overrides but skips the auto upsert."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_ENABLED", "false")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    reconcile = AsyncMock()
    upsert = AsyncMock()
    monkeypatch.setattr(lc, "reconcile_override_homes", reconcile)
    monkeypatch.setattr(lc, "upsert_auto_homes", upsert)

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    reconcile.assert_awaited_once()
    upsert.assert_not_awaited()


async def test_full_startup_site_home_failure_does_not_block_startup(monkeypatch):
    """Site homes are presentation data: a write failure logs a warning and
    startup still reaches a healthy, DB-available state."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        lc, "reconcile_override_homes", AsyncMock(side_effect=RuntimeError("db boom"))
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        assert app.state.db_available is True


async def test_ingestion_wires_per_file_hostnames(monkeypatch):
    """Each tailed file's parser gets its positional hostname; the service
    fallback gets the first resolved hostname."""
    from geometrikks.server import lifecycle as lc
    from geometrikks.config.settings import Settings

    monkeypatch.setenv("LOGPARSER_LOG_PATHS", '["/a.log", "/b.log"]')
    monkeypatch.setenv("LOGPARSER_HOST_NAME", '["vps-1", "vps-2"]')
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )

    app = SimpleNamespace(state=SimpleNamespace())
    app.state.settings = Settings()
    async with enter_lifespan(app):
        pass

    hostnames = [
        call.kwargs["hostname"] for call in cast("MagicMock", lc.LogParser).call_args_list
    ]
    assert hostnames == ["vps-1", "vps-2"]
    assert cast("MagicMock", lc.LogIngestionService).call_args.kwargs["hostname"] == "vps-1"


class _StartupWaitClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


async def test_wait_for_database_clamps_probe_timeout_to_remaining_budget(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("DISABLE_WAIT", "false")
    clock = _StartupWaitClock()
    timeouts: list[float] = []

    async def refused(app, timeout: float = 10.0) -> bool:
        timeouts.append(timeout)
        clock.now += 7.0
        return False

    monkeypatch.setattr(lc, "_db_available", refused)

    app = SimpleNamespace(state=SimpleNamespace())
    assert await lc._wait_for_database(cast("Any", app), 12.0, _clock=clock) is False
    assert timeouts == [10.0, 3.0]
    assert clock.sleeps == [2.0]


async def test_wait_for_database_does_not_probe_at_deadline(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("DISABLE_WAIT", "false")
    clock = _StartupWaitClock()
    probes = 0

    async def refused(app, timeout: float = 10.0) -> bool:
        nonlocal probes
        probes += 1
        clock.now += 5.0
        return False

    monkeypatch.setattr(lc, "_db_available", refused)

    app = SimpleNamespace(state=SimpleNamespace())
    assert await lc._wait_for_database(cast("Any", app), 5.0, _clock=clock) is False
    assert probes == 1
    assert clock.sleeps == []


async def test_wait_for_database_returns_on_success(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("DISABLE_WAIT", "false")
    clock = _StartupWaitClock()
    answers = iter([False, True])

    async def probe(app, timeout: float = 10.0) -> bool:
        return next(answers)

    monkeypatch.setattr(lc, "_db_available", probe)

    app = SimpleNamespace(state=SimpleNamespace())
    assert await lc._wait_for_database(cast("Any", app), 30.0, _clock=clock) is True
    assert clock.sleeps == [lc._PROBE_RETRY_DELAY]


@pytest.mark.parametrize("disable_wait", [False, True])
async def test_wait_for_database_zero_or_disabled_probes_once(
    monkeypatch, disable_wait: bool
):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("DISABLE_WAIT", str(disable_wait).lower())
    timeouts: list[float] = []

    async def refused(app, timeout: float = 10.0) -> bool:
        timeouts.append(timeout)
        return False

    monkeypatch.setattr(lc, "_db_available", refused)

    app = SimpleNamespace(state=SimpleNamespace())
    wait_seconds = 30.0 if disable_wait else 0.0
    assert await lc._wait_for_database(cast("Any", app), wait_seconds) is False
    assert timeouts == [10.0]


async def test_wait_for_database_propagates_cancellation(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("DISABLE_WAIT", "false")

    async def cancelled(app, timeout: float = 10.0) -> bool:
        raise asyncio.CancelledError

    monkeypatch.setattr(lc, "_db_available", cancelled)

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(asyncio.CancelledError):
        await lc._wait_for_database(
            cast("Any", app), 30.0, _clock=_StartupWaitClock()
        )


async def test_startup_wait_setting_defaults_and_rejects_negative_values():
    from pydantic import ValidationError

    from geometrikks.config.settings import DatabaseSettings

    assert DatabaseSettings(_env_file=None).startup_wait_seconds == 30
    with pytest.raises(ValidationError):
        DatabaseSettings(_env_file=None, startup_wait_seconds=-1)


async def test_db_availability_accessor_honors_default_and_recorded_state():
    from geometrikks.server.runtime import is_db_available

    app = SimpleNamespace(state=SimpleNamespace())
    assert is_db_available(cast("Any", app)) is True
    assert is_db_available(cast("Any", app), default=False) is False
    app.state.db_available = False
    assert is_db_available(cast("Any", app)) is False


class _RecoveryClock:
    def __init__(self) -> None:
        self.entered: asyncio.Queue[float] = asyncio.Queue()
        self.release = asyncio.Semaphore(0)

    async def sleep(self, seconds: float) -> None:
        self.entered.put_nowait(seconds)
        await self.release.acquire()

    async def tick(self, expected: float) -> None:
        assert await asyncio.wait_for(self.entered.get(), timeout=1.0) == expected
        self.release.release()


def _patch_recovery(monkeypatch, lc, answers: list[bool]) -> _RecoveryClock:
    clock = _RecoveryClock()
    monkeypatch.setattr(lc._SYSTEM_CLOCK, "sleep", clock.sleep)
    monkeypatch.setattr(lc, "_db_available", AsyncMock(side_effect=[False, *answers]))
    monkeypatch.setattr(lc, "reconcile_override_homes", AsyncMock())
    monkeypatch.setattr(lc, "upsert_auto_homes", AsyncMock())
    return clock


async def test_recovery_runs_deferred_startup_with_capped_backoff(monkeypatch):
    from geometrikks.server import lifecycle as lc
    from geometrikks.server import runtime

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    _patch_crowdsec_service(monkeypatch, lc)
    poller = cast("MagicMock", lc.CrowdSecStreamPoller).return_value
    backend = MagicMock(recover=AsyncMock())
    clock = _patch_recovery(monkeypatch, lc, [False, False, False, False, True])
    app = SimpleNamespace(state=SimpleNamespace(channels_backend=backend))

    async with enter_lifespan(app):
        task = app.state.db_recovery_task
        assert task.get_name() == "db-recovery"
        for delay in [10.0, 20.0, 40.0, 60.0, 60.0]:
            assert app.state.db_available is False
            await clock.tick(delay)
        await asyncio.wait_for(task, timeout=1.0)

        cast("AsyncMock", lc.migrate_database).assert_awaited_once()
        cast("AsyncMock", lc.setup_timescaledb).assert_awaited_once()
        cast("AsyncMock", lc.reconcile_override_homes).assert_awaited_once()
        cast("AsyncMock", lc.upsert_auto_homes).assert_awaited_once()
        backend.recover.assert_awaited_once()
        assert app.state.crowdsec_stream_poller is poller
        assert app.state.crowdsec_stream_poller_deferred is None
        assert app.state.scheduler is cast("AsyncMock", lc.create_scheduler).return_value
        ingestion.start.assert_awaited_once()
        assert app.state.db_available is True
        assert app.state.db_degraded_since is None
        assert "database-unavailable" not in [
            a.id for a in runtime.get_advisories(cast("Any", app)).snapshot()
        ]

    ingestion.stop.assert_awaited_once()


@pytest.mark.parametrize("stage", ["migration", "database setup", "scheduler", "ingestion"])
async def test_recovery_failure_is_terminal_and_unwinds_partial_services(monkeypatch, stage):
    from geometrikks.lib.advisories import DATABASE_RECOVERY_FAILED
    from geometrikks.server import lifecycle as lc
    from geometrikks.server import runtime

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    _patch_crowdsec_service(monkeypatch, lc)
    poller = cast("MagicMock", lc.CrowdSecStreamPoller).return_value
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.running = True
    clock = _patch_recovery(monkeypatch, lc, [True])
    failure = RuntimeError("recovery failed here")
    if stage == "migration":
        cast("AsyncMock", lc.migrate_database).side_effect = failure
    elif stage == "database setup":
        cast("AsyncMock", lc.setup_timescaledb).side_effect = failure
    elif stage == "scheduler":
        scheduler.start.side_effect = failure
    else:
        ingestion.start.side_effect = failure
    app = SimpleNamespace(state=SimpleNamespace())

    async with enter_lifespan(app):
        task = app.state.db_recovery_task
        since = app.state.db_degraded_since
        await clock.tick(10.0)
        await asyncio.wait_for(task, timeout=1.0)
        assert task.done()
        assert app.state.db_available is False
        assert app.state.db_degraded_since == since
        advisories = runtime.get_advisories(cast("Any", app)).snapshot()
        assert [a.id for a in advisories] == [DATABASE_RECOVERY_FAILED.id]
        advisory = advisories[0]
        assert advisory.severity == "critical"
        if stage == "migration":
            assert advisory == DATABASE_RECOVERY_FAILED
        else:
            assert stage in advisory.summary.lower()
            assert "migration failed" not in advisory.summary
            assert advisory.detail is not None and "Restart" in advisory.detail
        assert not hasattr(app.state, "scheduler")
        assert not hasattr(app.state, "ingestion_service")
        assert app.state.crowdsec_stream_poller is None
        assert app.state.crowdsec_stream_poller_deferred is poller
        if stage in {"scheduler", "ingestion"}:
            scheduler.shutdown.assert_called_once_with(wait=True)
        if stage == "ingestion":
            ingestion.stop.assert_awaited_once()
        cast("AsyncMock", lc.migrate_database).assert_awaited_once()
        assert clock.entered.empty()


async def test_recovery_continues_when_channels_backend_recover_fails(monkeypatch):
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    clock = _patch_recovery(monkeypatch, lc, [True])
    backend = MagicMock(recover=AsyncMock(side_effect=OSError("still refused")))
    app = SimpleNamespace(state=SimpleNamespace(channels_backend=backend))
    async with enter_lifespan(app):
        await clock.tick(10.0)
        await asyncio.wait_for(app.state.db_recovery_task, timeout=1.0)
        assert app.state.db_available is True
        backend.recover.assert_awaited_once()
        cast("AsyncMock", lc.create_scheduler).assert_awaited_once()
        backend.on_shutdown.assert_not_called()


async def test_shutdown_cancels_a_pending_recovery(monkeypatch):
    from geometrikks.server import lifecycle as lc

    _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    clock = _patch_recovery(monkeypatch, lc, [])
    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        task = app.state.db_recovery_task
        assert await asyncio.wait_for(clock.entered.get(), timeout=1.0) == 10.0
        assert not task.done()
    assert task.cancelled()
    cast("AsyncMock", lc.migrate_database).assert_not_awaited()


@pytest.mark.parametrize("stage", ["migration", "channels", "scheduler", "ingestion"])
@pytest.mark.parametrize("cancel_before_shutdown", [False, True])
async def test_shutdown_during_recovery_unwinds_before_client_closes(
    monkeypatch, stage, cancel_before_shutdown
):
    from geometrikks.server import lifecycle as lc

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    service = _patch_crowdsec_service(monkeypatch, lc)
    poller = cast("MagicMock", lc.CrowdSecStreamPoller).return_value
    clock = _patch_recovery(monkeypatch, lc, [True])
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    order: list[str] = []

    async def blocked(*args, **kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            order.append("cancelled")
            cancelled.set()

    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.running = True
    scheduler.shutdown.side_effect = lambda wait=True: order.append("scheduler")
    ingestion.stop.side_effect = lambda timeout=None: order.append("ingestion")
    service.aclose.side_effect = lambda: order.append("client")
    backend = MagicMock(recover=AsyncMock())
    if stage == "migration":
        cast("AsyncMock", lc.migrate_database).side_effect = blocked
    elif stage == "channels":
        backend.recover.side_effect = blocked
    elif stage == "scheduler":
        original = lc.start_scheduler

        async def start_then_block(app):
            await original(app)
            await blocked()

        monkeypatch.setattr(lc, "start_scheduler", start_then_block)
    else:
        ingestion.start.side_effect = blocked
    app = SimpleNamespace(state=SimpleNamespace(channels_backend=backend))
    async with enter_lifespan(app):
        task = app.state.db_recovery_task
        await clock.tick(10.0)
        await asyncio.wait_for(entered.wait(), timeout=1.0)
        assert app.state.db_available is False
        if cancel_before_shutdown:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not hasattr(app.state, "scheduler")
            assert not hasattr(app.state, "ingestion_service")
            assert app.state.crowdsec_stream_poller is None
            service.aclose.assert_not_awaited()
    assert task.cancelled()
    assert cancelled.is_set()
    assert order == {
        "migration": ["cancelled", "client"],
        "channels": ["cancelled", "client"],
        "scheduler": ["cancelled", "scheduler", "client"],
        "ingestion": ["cancelled", "ingestion", "scheduler", "client"],
    }[stage]
    assert app.state.crowdsec_stream_poller is None
    assert app.state.crowdsec_stream_poller_deferred is poller
    assert not hasattr(app.state, "scheduler")
    assert not hasattr(app.state, "ingestion_service")
    assert app.state.db_available is False


@pytest.mark.parametrize("cleanup_cancelled", [False, True])
async def test_recovery_cleanup_failure_keeps_handle_and_still_stops_scheduler(
    monkeypatch, cleanup_cancelled
):
    from geometrikks.server import lifecycle as lc
    from geometrikks.server import runtime

    _enable_crowdsec(monkeypatch)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    _patch_crowdsec_service(monkeypatch, lc)
    clock = _patch_recovery(monkeypatch, lc, [True])
    ingestion.start.side_effect = RuntimeError("tailer exploded")
    cleanup_error = asyncio.CancelledError() if cleanup_cancelled else RuntimeError("cleanup failed")
    ingestion.stop.side_effect = [cleanup_error, None]
    scheduler = cast("AsyncMock", lc.create_scheduler).return_value
    scheduler.running = True
    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        await clock.tick(10.0)
        if cleanup_cancelled:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(app.state.db_recovery_task, timeout=1.0)
        else:
            await asyncio.wait_for(app.state.db_recovery_task, timeout=1.0)
        assert app.state.ingestion_service is ingestion
        scheduler.shutdown.assert_called_once_with(wait=True)
        assert not hasattr(app.state, "scheduler")
        assert app.state.crowdsec_stream_poller is None
        assert runtime.get_advisories(cast("Any", app)).snapshot()[0].id == "database-recovery-failed"
    assert ingestion.stop.await_count == 2
    assert not hasattr(app.state, "ingestion_service")


async def test_recovery_lifespan_awaits_already_completed_task(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setattr(lc, "_recover_database", AsyncMock(side_effect=RuntimeError("unexpected task error")))
    app = SimpleNamespace(state=SimpleNamespace(db_available=False))
    finished = asyncio.Event()
    with pytest.raises(RuntimeError, match="unexpected task error"):
        async with lc.db_recovery_lifespan(cast("Any", app)):
            app.state.db_recovery_task.add_done_callback(lambda task: finished.set())
            await asyncio.wait_for(finished.wait(), timeout=1.0)
            assert app.state.db_recovery_task.done()


@pytest.mark.parametrize("agent", [False, True])
async def test_no_recovery_task_for_healthy_startup_or_agent(monkeypatch, agent):
    from geometrikks.config.settings import Settings
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("APP_MODE", "agent" if agent else "full")
    _patch_startup_collaborators(
        monkeypatch, lc, db_available=True, ensure=AsyncMock(return_value=True)
    )
    monkeypatch.setattr(lc, "wait_for_schema", AsyncMock(return_value="timeout"))
    app = SimpleNamespace(state=SimpleNamespace(settings=Settings()))
    async with enter_lifespan(app):
        assert not hasattr(app.state, "db_recovery_task")


async def test_recovery_respects_disabled_ingestion(monkeypatch):
    from geometrikks.server import lifecycle as lc

    monkeypatch.setenv("LOGPARSER_ENABLED", "false")
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    clock = _patch_recovery(monkeypatch, lc, [True])
    app = SimpleNamespace(state=SimpleNamespace())
    async with enter_lifespan(app):
        await clock.tick(10.0)
        await asyncio.wait_for(app.state.db_recovery_task, timeout=1.0)
        assert app.state.db_available is True
        cast("AsyncMock", lc.create_scheduler).assert_awaited_once()
        ingestion.start.assert_not_awaited()


async def test_recovery_elapsed_time_includes_bringup_and_service_start(monkeypatch):
    from datetime import datetime, timedelta, timezone

    from geometrikks.server import lifecycle as lc

    now = datetime(2026, 9, 6, tzinfo=timezone.utc)

    class RecoveryDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(lc, "datetime", RecoveryDateTime)
    log = MagicMock()
    monkeypatch.setattr(lc, "logger", log)
    ingestion, _ = _patch_startup_collaborators(
        monkeypatch, lc, db_available=False, ensure=AsyncMock(return_value=True)
    )
    clock = _patch_recovery(monkeypatch, lc, [True])
    app = SimpleNamespace(state=SimpleNamespace())

    async def migrate(*args):
        nonlocal now
        assert app.state.db_available is False
        now += timedelta(seconds=7)

    async def start(**kwargs):
        nonlocal now
        assert app.state.db_available is False
        now += timedelta(seconds=3)

    cast("AsyncMock", lc.migrate_database).side_effect = migrate
    ingestion.start.side_effect = start
    async with enter_lifespan(app):
        now += timedelta(seconds=10)
        await clock.tick(10.0)
        await asyncio.wait_for(app.state.db_recovery_task, timeout=1.0)
        assert app.state.db_available is True
        log.info.assert_any_call("db_recovery_started", degraded_seconds=10.0)
        log.info.assert_any_call("db_recovered", degraded_seconds=20.0)
