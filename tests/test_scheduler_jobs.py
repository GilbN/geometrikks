"""Scheduled job bodies raise on failure so the run tracker records it."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server import scheduler as sched
from geometrikks.server.timescale import ALL_CAGGS

pytestmark = pytest.mark.anyio


def _session_factory(session: Any):
    @asynccontextmanager
    async def _ctx():
        yield session

    return lambda: _ctx()


async def test_refresh_all_caggs_tries_every_cagg_then_raises(monkeypatch):
    called: list[str] = []

    async def fake_call(session_factory, sql: str, *args):
        name = sql.split("'")[1]
        called.append(name)
        if name == ALL_CAGGS[1]:
            raise RuntimeError("lock timeout")

    monkeypatch.setattr(sched, "_execute_call_outside_transaction", fake_call)

    message = (
        rf"1 of {len(ALL_CAGGS)} aggregates failed to refresh: {ALL_CAGGS[1]}"
    )
    with pytest.raises(RuntimeError, match=message):
        await sched.refresh_all_caggs_job(cast("Any", object()))

    assert called == list(ALL_CAGGS)


async def test_refresh_all_caggs_succeeds_quietly(monkeypatch):
    called: list[str] = []

    async def fake_call(session_factory, sql: str, *args):
        called.append(sql.split("'")[1])

    monkeypatch.setattr(sched, "_execute_call_outside_transaction", fake_call)

    await sched.refresh_all_caggs_job(cast("Any", object()))

    assert called == list(ALL_CAGGS)


async def test_location_refresh_job_propagates_service_failure(monkeypatch):
    from geometrikks.services.aggregation import service as agg

    session = MagicMock()
    session.commit = AsyncMock()
    failing = MagicMock()
    failing.refresh_location_last_hits = AsyncMock(
        side_effect=RuntimeError("deadlock")
    )
    monkeypatch.setattr(agg, "AggregationService", MagicMock(return_value=failing))

    with pytest.raises(RuntimeError, match="deadlock"):
        await sched.refresh_location_last_hits_job(_session_factory(session))

    session.commit.assert_not_awaited()


async def test_refresh_location_last_hits_reraises_after_logging():
    from geometrikks.services.aggregation.service import AggregationService

    session = MagicMock()
    session.execute = AsyncMock(side_effect=RuntimeError("deadlock"))

    with pytest.raises(RuntimeError, match="deadlock"):
        await AggregationService(session=session).refresh_location_last_hits()
