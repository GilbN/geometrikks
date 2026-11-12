"""The AbuseIPDB blacklist job's registration and failure signal, and the read path without a database."""
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import SecretStr

from geometrikks.config.settings import AbuseIpdbSettings, SchedulerSettings, Settings
from geometrikks.domain.abuseipdb.blacklist import BlacklistOutcome, BlacklistView, current_blacklist
from geometrikks.domain.drop.refresh import FirstRunFlag
from geometrikks.server import scheduler as sched

pytestmark = pytest.mark.anyio


def blacklist_settings(
    *, enabled: bool = True, scheduler_enabled: bool = True, refresh_hours: int = 24
) -> Settings:
    return Settings(
        scheduler=SchedulerSettings(enabled=scheduler_enabled, _env_file=None),
        abuseipdb=AbuseIpdbSettings(
            api_key=SecretStr("test-key") if enabled else None,
            blacklist_enabled=enabled,
            blacklist_refresh_hours=refresh_hours,
            _env_file=None,
        ),
    )


async def test_registered_on_a_server_with_the_feature_on():
    before = datetime.now(timezone.utc)
    scheduler = await sched.create_scheduler(MagicMock(), blacklist_settings(refresh_hours=12), mode="full")

    job = scheduler.get_job("abuseipdb-blacklist-refresh")
    assert job is not None
    assert job.func is sched.abuseipdb_blacklist_refresh_job
    assert job.trigger.interval == timedelta(hours=12)
    assert job.max_instances == 1
    assert job.misfire_grace_time == 3600
    assert before + timedelta(seconds=50) <= job.next_run_time <= before + timedelta(seconds=70)


@pytest.mark.parametrize(
    ("mode", "enabled", "scheduler_enabled"),
    [("agent", True, True), ("full", False, True), ("full", True, False)],
    ids=["agent", "feature-off", "scheduler-off"],
)
async def test_not_registered(mode, enabled, scheduler_enabled):
    settings = blacklist_settings(enabled=enabled, scheduler_enabled=scheduler_enabled)

    scheduler = await sched.create_scheduler(MagicMock(), settings, mode=mode)

    assert scheduler.get_job("abuseipdb-blacklist-refresh") is None


def patch_refresh(monkeypatch: pytest.MonkeyPatch, outcome: BlacklistOutcome) -> AsyncMock:
    refresh = AsyncMock(return_value=outcome)
    monkeypatch.setattr("geometrikks.domain.abuseipdb.blacklist.refresh_blacklist", refresh)
    return refresh


async def test_the_job_raises_when_the_refresh_failed(monkeypatch):
    patch_refresh(monkeypatch, BlacklistOutcome("failed", None, "AbuseIPDB answered 503"))

    with pytest.raises(RuntimeError, match="AbuseIPDB answered 503"):
        await sched.abuseipdb_blacklist_refresh_job(MagicMock(), blacklist_settings())


@pytest.mark.parametrize("status", ["refreshed", "skipped"])
async def test_the_job_returns_when_it_refreshed_or_skipped(monkeypatch, status):
    patch_refresh(monkeypatch, BlacklistOutcome(status, None, None))

    await sched.abuseipdb_blacklist_refresh_job(MagicMock(), blacklist_settings())


async def test_only_the_first_run_after_startup_passes_startup(monkeypatch):
    refresh = patch_refresh(monkeypatch, BlacklistOutcome("skipped", None, "fresh"))
    first_run = FirstRunFlag()
    settings = blacklist_settings(refresh_hours=6)

    await sched.abuseipdb_blacklist_refresh_job(MagicMock(), settings, first_run)
    await sched.abuseipdb_blacklist_refresh_job(MagicMock(), settings, first_run)

    assert [call.kwargs["startup"] for call in refresh.await_args_list] == [True, False]
    assert refresh.await_args_list[0].kwargs["refresh_hours"] == 6


async def test_the_read_path_touches_no_table_with_the_feature_off():
    blacklist_view = await current_blacklist(MagicMock(side_effect=AssertionError), enabled=False, now=datetime.now(UTC))

    assert blacklist_view == BlacklistView(generated_at=None, refreshed_at=None, ips=[])
