"""Persistence for server locations (the server_locations table).

Raw pg_insert instead of the service layer: the auto upsert needs a
conditional ON CONFLICT DO UPDATE ... WHERE source <> 'override', which
the repository/service API cannot express (same precedent as the
ingestion service's geo_locations upsert).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError
from geometrikks.domain.geo.models import ServerLocation
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.services.geoip.self_location import SelfLocation

logger = get_logger(__name__)


async def upsert_auto_server_locations(
    session_maker: "Callable[[], AsyncSession]",
    server_names: list[str],
    self_location: "SelfLocation | None",
) -> None:
    """Record this process's detected location for each server name it ingests.

    A None location (detection failed / geo-degraded) writes nothing and keeps
    any existing rows, so a flaky IP check can't erase a server's beacon.
    """
    if self_location is None or not server_names:
        return
    now = datetime.now(timezone.utc)
    affected: list[str] = []
    async with session_maker() as session:
        # Sorted, not input order: concurrent writers must lock rows in the
        # same order to avoid a deadlock.
        for server_name in sorted(dict.fromkeys(server_names)):
            stmt = (
                pg_insert(ServerLocation)
                .values(
                    server=server_name,
                    latitude=self_location.latitude,
                    longitude=self_location.longitude,
                    source="auto",
                    detected_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["server"],
                    set_={
                        "latitude": self_location.latitude,
                        "longitude": self_location.longitude,
                        "detected_at": now,
                        "updated_at": now,
                    },
                    where=(ServerLocation.source != "override"),
                )
            )
            result = await session.execute(stmt)
            # An upsert always yields a CursorResult; Result[Any] lacks rowcount.
            if cast("CursorResult[Any]", result).rowcount:
                affected.append(server_name)
        await session.commit()
    # Skip the log entirely when every row was guarded off by the override
    # WHERE clause; a no-op upsert is not worth an audit line.
    if affected:
        logger.info("server_locations_auto_upserted", server_names=affected, rows=len(affected))


async def reconcile_override_server_locations(
    session_maker: "Callable[[], AsyncSession]",
    overrides: dict[str, tuple[float, float]],
) -> None:
    """Make override rows exactly match MAP_SERVER_LOCATIONS.

    Removed overrides are deleted (not demoted): the owning agent's next
    auto upsert recreates the row, so there is no stale-override limbo.
    """
    now = datetime.now(timezone.utc)
    async with session_maker() as session:
        # Sorted, not dict order: consistent lock order across concurrent writers.
        for server_name, (latitude, longitude) in sorted(overrides.items()):
            stmt = (
                pg_insert(ServerLocation)
                .values(
                    server=server_name,
                    latitude=latitude,
                    longitude=longitude,
                    source="override",
                    detected_at=None,
                )
                .on_conflict_do_update(
                    index_elements=["server"],
                    set_={
                        "latitude": latitude,
                        "longitude": longitude,
                        "source": "override",
                        "detected_at": None,
                        "updated_at": now,
                    },
                )
            )
            await session.execute(stmt)
        if overrides:
            await session.execute(
                delete(ServerLocation).where(
                    ServerLocation.source == "override",
                    ServerLocation.server.not_in(list(overrides)),
                )
            )
        else:
            await session.execute(delete(ServerLocation).where(ServerLocation.source == "override"))
        await session.commit()
    if overrides:
        logger.info("server_locations_overrides_reconciled", server_names=sorted(overrides))


async def fetch_server_locations(session: "AsyncSession") -> list[ServerLocation]:
    result = await session.execute(select(ServerLocation).order_by(ServerLocation.server))
    return list(result.scalars())


async def fetch_last_event_days(session: "AsyncSession") -> dict[str, datetime]:
    """Most recent day with traffic per server.

    Reads the server_daily_stats aggregate, not geo_events. The raw table
    only has a single-column server index, so a per-server max(timestamp)
    would walk every row of a busy server. Day precision is enough to tell a
    retired server from a live one.
    """
    result = await session.execute(
        text("SELECT server, max(bucket) AS last_day FROM server_daily_stats GROUP BY server")
    )
    return {row.server: row.last_day for row in result}


async def remove_server_location(session: "AsyncSession", server: str, *, actor: str) -> None:
    """Remove one server's location row.

    Only auto rows can go. Override rows mirror MAP_SERVER_LOCATIONS and would
    be recreated at the next startup, so deleting one here would only
    mislead. A deleted auto row comes back at the owning agent's next location
    refresh if that agent still runs; the delete is for retired servers.
    """
    row = (await session.execute(select(ServerLocation).where(ServerLocation.server == server))).scalar_one_or_none()
    if row is None:
        raise DomainNotFoundError(f"No location recorded for server {server!r}")
    if row.source == "override":
        raise DomainConflictError(f"MAP_SERVER_LOCATIONS pins server {server!r}; remove its entry there instead")
    await session.delete(row)
    await session.commit()
    logger.info("server_location_deleted", server=server, source="auto", actor=actor)
