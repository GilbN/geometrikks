"""Find unfinished hostname aggregates without reading the raw event history."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from geometrikks.server.timescale import IP_LOCATION_CAGGS_NAMES


@dataclass(frozen=True)
class HostnameBackfillRange:
    view: str
    start: datetime
    end: datetime


async def pending_hostname_range(
    conn: AsyncConnection, view: str, start: datetime, end: datetime,
) -> HostnameBackfillRange | None:
    if view not in IP_LOCATION_CAGGS_NAMES:
        raise ValueError(f"Unknown per-IP aggregate: {view}")
    row = (await conn.execute(text(
        f"SELECT MIN(bucket), MAX(bucket) FROM {view} "
        "WHERE hostname_hits IS NULL AND bucket >= :start AND bucket < :end"
    ), {"start": start, "end": end})).one()
    if row[0] is None:
        return None
    width = timedelta(days=1) if "daily" in view else timedelta(hours=1)
    return HostnameBackfillRange(view, row[0], row[1] + width)


async def hostname_backfill_ranges(
    conn: AsyncConnection, *, now: datetime, raw_retention_days: int, hourly_retention_days: int,
) -> list[HostnameBackfillRange]:
    """Only complete buckets whose raw data and aggregate retention still overlap.

    NULL markers outside that window are permanent historical gaps. Refreshing
    them after their source rows expired could erase existing counts.
    """
    columns = {
        (r.table_name, r.column_name)
        for r in await conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = ANY(:views)"
        ), {"views": IP_LOCATION_CAGGS_NAMES})
    }
    for view in IP_LOCATION_CAGGS_NAMES:
        if not all((view, column) in columns for column in ("hostnames", "hostname_hits")):
            raise ValueError(
                f"{view} is missing hostname columns. Start the updated app first. "
                "If adding the columns failed, check its database setup log; "
                "in-place column upgrades require TimescaleDB 2.28 or later."
            )
    ranges = []
    for view in IP_LOCATION_CAGGS_NAMES:
        hourly = "hourly" in view
        days = min(raw_retention_days, hourly_retention_days) if hourly else raw_retention_days
        horizon = now - timedelta(days=days)
        start = horizon.replace(minute=0, second=0, microsecond=0)
        end = now.replace(minute=0, second=0, microsecond=0)
        width = timedelta(hours=1)
        if not hourly:
            start = start.replace(hour=0)
            end = end.replace(hour=0)
            width = timedelta(days=1)
        if start < horizon:
            start += width
        pending = await pending_hostname_range(conn, view, start, end)
        if pending is not None:
            ranges.append(pending)
    return ranges
