"""AsyncPg channels round trip against the real integration database."""
from __future__ import annotations

import asyncio

import pytest
from litestar.channels import ChannelsPlugin
from msgspec import json as msgspec_json

from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL
from geometrikks.server.plugins import DegradedTolerantAsyncPgBackend

pytestmark = [pytest.mark.integration, pytest.mark.anyio]


async def test_publish_subscribe_round_trip(it_asyncpg_dsn) -> None:
    channels = ChannelsPlugin(
        backend=DegradedTolerantAsyncPgBackend(dsn=it_asyncpg_dsn),
        channels=[LIVE_EVENTS_CHANNEL],
    )
    async with channels:
        async with channels.start_subscription(LIVE_EVENTS_CHANNEL) as subscriber:
            channels.publish({"type": "geo_event", "data": {"hostname": "vps-1"}}, LIVE_EVENTS_CHANNEL)

            async def _first_event() -> dict:
                async for raw in subscriber.iter_events():
                    return msgspec_json.decode(raw)
                raise AssertionError("subscriber closed without an event")

            event = await asyncio.wait_for(_first_event(), timeout=10)
    assert event["data"]["hostname"] == "vps-1"


async def test_two_writers_one_subscriber(it_asyncpg_dsn) -> None:
    channels = ChannelsPlugin(
        backend=DegradedTolerantAsyncPgBackend(dsn=it_asyncpg_dsn),
        channels=[LIVE_EVENTS_CHANNEL],
    )
    async with channels:
        async with channels.start_subscription(LIVE_EVENTS_CHANNEL) as subscriber:
            for host in ("vps-1", "vps-2"):
                channels.publish({"type": "geo_event", "data": {"hostname": host}}, LIVE_EVENTS_CHANNEL)

            async def _collect_both() -> set[str]:
                seen: set[str] = set()
                async for raw in subscriber.iter_events():
                    seen.add(msgspec_json.decode(raw)["data"]["hostname"])
                    if seen == {"vps-1", "vps-2"}:
                        return seen
                return seen

            seen = await asyncio.wait_for(_collect_both(), timeout=10)
    assert seen == {"vps-1", "vps-2"}
