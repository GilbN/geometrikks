"""Persistence for per-source home locations (the site_homes table).

Raw pg_insert instead of the service layer: the auto upsert needs a
conditional ON CONFLICT DO UPDATE ... WHERE source <> 'override', which
the repository/service API cannot express (same precedent as the
ingestion service's geo_locations upsert).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from geometrikks.domain.geo.models import SiteHome
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.services.geoip.home import HomeLocation

logger = get_logger(__name__)


async def upsert_auto_homes(
    session_maker: "Callable[[], AsyncSession]",
    hostnames: list[str],
    home: "HomeLocation | None",
) -> None:
    """Record this process's detected home for each hostname it ingests.

    None home (detection failed / geo-degraded) writes nothing and keeps
    any existing rows: a flaky IP check must not erase a site's beacon.
    """
    if home is None or not hostnames:
        return
    now = datetime.now(timezone.utc)
    affected: list[str] = []
    async with session_maker() as session:
        # Sorted, not input order: concurrent writers must lock rows in the
        # same order to avoid a deadlock.
        for hostname in sorted(dict.fromkeys(hostnames)):
            stmt = (
                pg_insert(SiteHome)
                .values(
                    hostname=hostname,
                    latitude=home.latitude,
                    longitude=home.longitude,
                    source="auto",
                    detected_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["hostname"],
                    set_={
                        "latitude": home.latitude,
                        "longitude": home.longitude,
                        "detected_at": now,
                        "updated_at": now,
                    },
                    where=(SiteHome.source != "override"),
                )
            )
            result = await session.execute(stmt)
            # An upsert always yields a CursorResult; Result[Any] lacks rowcount.
            if cast("CursorResult[Any]", result).rowcount:
                affected.append(hostname)
        await session.commit()
    # Skip the log entirely when every row was guarded off by the override
    # WHERE clause; a no-op upsert is not worth an audit line.
    if affected:
        logger.info("site_homes_auto_upserted", hostnames=affected, rows=len(affected))


async def reconcile_override_homes(
    session_maker: "Callable[[], AsyncSession]",
    overrides: dict[str, tuple[float, float]],
) -> None:
    """Make override rows exactly match MAP_HOME_LOCATIONS.

    Removed overrides are deleted (not demoted): the owning agent's next
    auto upsert recreates the row, so there is no stale-override limbo.
    """
    now = datetime.now(timezone.utc)
    async with session_maker() as session:
        # Sorted, not dict order: consistent lock order across concurrent writers.
        for hostname, (latitude, longitude) in sorted(overrides.items()):
            stmt = (
                pg_insert(SiteHome)
                .values(
                    hostname=hostname,
                    latitude=latitude,
                    longitude=longitude,
                    source="override",
                    detected_at=None,
                )
                .on_conflict_do_update(
                    index_elements=["hostname"],
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
                delete(SiteHome).where(
                    SiteHome.source == "override",
                    SiteHome.hostname.not_in(list(overrides)),
                )
            )
        else:
            await session.execute(delete(SiteHome).where(SiteHome.source == "override"))
        await session.commit()
    if overrides:
        logger.info("site_homes_overrides_reconciled", hostnames=sorted(overrides))


async def fetch_site_homes(session: "AsyncSession") -> list[SiteHome]:
    result = await session.execute(select(SiteHome).order_by(SiteHome.hostname))
    return list(result.scalars())
