"""Aggregation service for analytics - simplified for TimescaleDB.

TimescaleDB continuous aggregates handle:
- Real-time aggregation with automatic refresh policies
- HyperLogLog sketches for unique counts
- Retention policies

This service handles tasks that require application logic:
- GeoLocation.last_hit refresh (updates regular table from hypertable data)
- Manual CAGG refresh for backfilling
"""

from __future__ import annotations

import logging
from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import text

from geometrikks.server.timescale import ALL_CAGGS

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class AggregationService:
    """Service for analytics operations not handled by TimescaleDB.

    TimescaleDB continuous aggregates automatically handle hourly/daily
    aggregations with HyperLogLog for unique counts. This service provides:
    1. GeoLocation.last_hit refresh (updates regular table)
    2. Manual aggregate refresh if needed

    Example:
        service = AggregationService(session=session)
        await service.refresh_location_last_hits()
    """

    def __init__(self, session: "AsyncSession") -> None:
        """Initialize the aggregation service.

        Args:
            session: SQLAlchemy async session.
        """
        self.session = session

        # Statistics
        self.total_location_refreshes: int = 0
        self.last_refresh_date: date | None = None

    async def refresh_location_last_hits(self) -> int:
        """Update GeoLocation.last_hit from actual GeoEvent timestamps.

        This derives the accurate last_hit timestamp by finding MAX(timestamp)
        from geo_events for each location. Only updates locations where the
        computed max is greater than the current last_hit (or last_hit is NULL).

        Returns:
            Number of locations updated.
        """
        try:
            # Use raw SQL for efficient bulk update with subquery
            stmt = text("""
                UPDATE geo_locations gl
                SET last_hit = subq.max_ts
                FROM (
                    SELECT location_id, MAX(timestamp) as max_ts
                    FROM geo_events
                    GROUP BY location_id
                ) subq
                WHERE gl.id = subq.location_id
                  AND (gl.last_hit IS NULL OR gl.last_hit < subq.max_ts)
            """)
            result = await self.session.execute(stmt)
            updated = result.rowcount or 0
            if updated > 0:
                self.total_location_refreshes += updated
                logger.info("Refreshed last_hit for %d locations", updated)
            return updated
        except Exception as e:
            logger.exception("Failed to refresh location last_hits: %s", e)
            return 0

    async def force_refresh_continuous_aggregates(self) -> None:
        """Force refresh of TimescaleDB continuous aggregates.

        Call this if you need to update aggregates immediately rather than
        waiting for the scheduled refresh policy. Useful after bulk data imports.

        Note: This uses CALL statements which must be executed outside of
        a transaction. Consider using the scheduler's refresh functions instead.
        """
        for cagg_name in ALL_CAGGS:
            try:
                await self.session.execute(
                    text(f"CALL refresh_continuous_aggregate('{cagg_name}', NULL, NOW())")
                )
                logger.info("Refreshed %s", cagg_name)
            except Exception as e:
                logger.warning("Failed to refresh %s: %s", cagg_name, e)

        logger.info("Forced refresh of all continuous aggregates complete")
