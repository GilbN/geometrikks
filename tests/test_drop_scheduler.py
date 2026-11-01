"""The drop-refresh job: registration rules and the all-feeds-failed signal."""
from datetime import datetime, timedelta, timezone
from typing import Literal, get_args
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.config.settings import DropSettings, SchedulerSettings, Settings
from geometrikks.domain.drop.feeds import DropFeed
from geometrikks.domain.drop.refresh import FeedOutcome, FirstRunFlag
from geometrikks.server import scheduler as sched

pytestmark = pytest.mark.anyio

FeedStatus = Literal["imported", "unchanged", "skipped", "failed"]


def drop_settings(*, drop_enabled: bool = True, scheduler_enabled: bool = True, refresh_hours: int = 24) -> Settings:
    return Settings(
        scheduler=SchedulerSettings(enabled=scheduler_enabled, _env_file=None),
        drop=DropSettings(enabled=drop_enabled, refresh_hours=refresh_hours, _env_file=None),
    )


async def test_drop_refresh_registered_on_a_head_with_the_feature_on():
    before = datetime.now(timezone.utc)
    scheduler = await sched.create_scheduler(MagicMock(), drop_settings(refresh_hours=12), mode="full")

    job = scheduler.get_job("drop-refresh")
    assert job is not None
    assert job.func is sched.drop_refresh_job
    assert job.name == "DROP lists refresh"
    assert job.trigger.interval == timedelta(hours=12)
    assert job.max_instances == 1
    assert job.misfire_grace_time == 3600
    assert before + timedelta(seconds=50) <= job.next_run_time <= before + timedelta(seconds=70)


@pytest.mark.parametrize(
    ("mode", "drop_enabled", "scheduler_enabled"),
    [("agent", True, True), ("full", False, True), ("full", True, False)],
    ids=["agent", "drop-disabled", "scheduler-disabled"],
)
async def test_drop_refresh_not_registered(mode, drop_enabled, scheduler_enabled):
    settings = drop_settings(drop_enabled=drop_enabled, scheduler_enabled=scheduler_enabled)
    scheduler = await sched.create_scheduler(MagicMock(), settings, mode=mode)

    assert scheduler.get_job("drop-refresh") is None


def patch_refresh(monkeypatch: pytest.MonkeyPatch, statuses: list[FeedStatus]) -> AsyncMock:
    feed_outcomes = [
        FeedOutcome(feed, status, None, "reason")
        for feed, status in zip(get_args(DropFeed), statuses, strict=True)
    ]
    refresh = AsyncMock(return_value=feed_outcomes)
    monkeypatch.setattr("geometrikks.domain.drop.refresh.refresh_drop_lists", refresh)
    return refresh


async def test_the_job_raises_when_every_attempted_feed_failed(monkeypatch):
    patch_refresh(monkeypatch, ["failed", "failed", "failed"])

    with pytest.raises(RuntimeError, match="v4: reason; v6: reason; asn: reason"):
        await sched.drop_refresh_job(MagicMock(), drop_settings())


async def test_the_job_ignores_skipped_feeds_when_judging_failure(monkeypatch):
    patch_refresh(monkeypatch, ["skipped", "failed", "failed"])

    with pytest.raises(RuntimeError, match="v6: reason; asn: reason"):
        await sched.drop_refresh_job(MagicMock(), drop_settings())


@pytest.mark.parametrize("statuses", [["failed", "imported", "failed"], ["skipped"] * 3, ["unchanged"] * 3])
async def test_the_job_returns_when_a_feed_succeeded_or_none_were_due(monkeypatch, statuses):
    patch_refresh(monkeypatch, statuses)

    await sched.drop_refresh_job(MagicMock(), drop_settings())


async def test_only_the_first_run_after_startup_passes_startup(monkeypatch):
    refresh = patch_refresh(monkeypatch, ["skipped"] * 3)
    first_run = FirstRunFlag()

    await sched.drop_refresh_job(MagicMock(), drop_settings(refresh_hours=6), first_run)
    await sched.drop_refresh_job(MagicMock(), drop_settings(refresh_hours=6), first_run)

    assert [call.kwargs["startup"] for call in refresh.await_args_list] == [True, False]
    assert refresh.await_args_list[0].kwargs["refresh_hours"] == 6
