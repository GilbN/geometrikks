"""Operator advisories and the registry that stores open advisories."""

from __future__ import annotations

from typing import Literal

import msgspec

from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class Advisory(msgspec.Struct, rename="camel"):
    id: str
    severity: Literal["warning", "critical"]
    summary: str
    detail: str | None = None
    remedy: str | None = None
    docs_url: str | None = None


class AdvisoryRegistry:
    """Per-process set of open advisories, keyed by id."""

    def __init__(self) -> None:
        self._items: dict[str, Advisory] = {}

    def set(self, advisory: Advisory) -> None:
        """Upsert by id; a repeat set keeps the original position."""
        if advisory.id not in self._items:
            logger.info("advisory_set", id=advisory.id, severity=advisory.severity)
        self._items[advisory.id] = advisory

    def clear(self, advisory_id: str) -> bool:
        if self._items.pop(advisory_id, None) is None:
            return False
        logger.info("advisory_cleared", id=advisory_id)
        return True

    def snapshot(self) -> list[Advisory]:
        """Critical first, then insertion order."""
        items = list(self._items.values())
        return [a for a in items if a.severity == "critical"] + [
            a for a in items if a.severity != "critical"
        ]


DATABASE_UNAVAILABLE = Advisory(
    id="database-unavailable",
    severity="critical",
    summary=(
        "The database was unreachable when the app started. Background jobs, "
        "ingestion and the live feeds are paused."
    ),
    detail=(
        "The app keeps checking every few seconds and resumes on its own when "
        "the database answers. Dashboards work as soon as it does, but nothing "
        "new is ingested or refreshed until recovery completes. Check the "
        "database container if this persists."
    ),
)

DATABASE_RECOVERY_FAILED = Advisory(
    id="database-recovery-failed",
    severity="critical",
    summary="The database is reachable again but the startup migration failed.",
    detail="Restart the container. If it fails again, check the app log for the migration error.",
)

MAP_HOME_UNDETECTED = Advisory(
    id="map-home-undetected",
    severity="warning",
    summary=(
        "The map's home location could not be detected, so routes have no "
        "origin and the home marker is hidden."
    ),
    detail=(
        "Detection needs outbound access to the public-IP service and a City "
        "database that knows the result. The site-home-refresh job retries on "
        "its interval."
    ),
    remedy="MAP_HOME_LATITUDE and MAP_HOME_LONGITUDE",
)
