"""Operator advisories and the registry that stores open advisories."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Literal

import msgspec

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from geometrikks.config.settings import LegacyEnvName

logger = get_logger(__name__)

INGESTION_WRITE_FAILURES_ID = "ingestion-write-failures"
# A bad record fails one batch; a write path that is broken fails every batch.
# This many failed batches inside the 5-minute window, with nothing written,
# make failing writes critical.
ONGOING_FAILED_BATCHES = 2

_EXCEPTION_PREFIX = re.compile(r"^\(\w+(?:\.\w+)+\)\s*")
_CLASS_PREFIX = re.compile(r"^<class '[\w.]+'>:\s*")
_QUERY_ARGUMENT_VALUE = re.compile(r"(query argument \$\d+).*$")
_SINGLE_QUOTED = re.compile(r"'[^']*(?:'|$)")
_VALUE_AFTER_COLON = re.compile(r':\s*"[^"]*(?:"|$)')


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
        "The database was unreachable when the app started; background jobs, "
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
    detail=(
        "Automatic recovery has stopped. Restart the container. If it fails "
        "again, check the app log for the migration error."
    ),
)

SERVER_LOCATION_UNDETECTED = Advisory(
    id="server-location-undetected",
    severity="warning",
    summary=(
        "This server's location could not be detected, so routes have no "
        "origin and its map marker is hidden."
    ),
    detail=(
        "Map traffic stays visible, just without route origins or a server "
        "marker. Check outbound access to the public-IP service and that the "
        "City database can locate its result, or set the coordinates yourself. "
        "When scheduling and background jobs are active, the "
        "server-location-refresh job retries detection."
    ),
    remedy="MAP_SERVER_LATITUDE and MAP_SERVER_LONGITUDE",
)

CITY_DATABASE_MISSING = Advisory(
    id="geoip-database-missing",
    severity="warning",
    summary=(
        "The GeoLite2 City database is missing or unreadable, so log ingestion "
        "cannot start."
    ),
    detail=(
        "The app keeps serving the UI, but ingestion stays stopped until a usable "
        "City database is available. If MaxMind credentials and scheduled jobs are "
        "enabled, the geoip-refresh job retries the download; otherwise replace the "
        "database file or configure credentials and restart the app."
    ),
    remedy="MAXMINDDB_USER_ID and MAXMINDDB_LICENSE_KEY",
)

INGESTION_STOPPED = Advisory(
    id="ingestion-stopped",
    severity="critical",
    summary="Log ingestion stopped unexpectedly; new records are not being processed.",
    detail=(
        "The app detected that its log-tail and database-write task exited while "
        "ingestion was enabled. Check the app log for the ingestion error and "
        "restart the app after fixing the cause."
    ),
)


def legacy_env_advisory(names: list["LegacyEnvName"]) -> Advisory:
    """Warn that this process reads env vars under names that were renamed."""
    renames = "\n".join(f"{legacy_env_name.old} → {legacy_env_name.new}" for legacy_env_name in names)
    noun = "variable uses its old name" if len(names) == 1 else "variables use their old names"
    return Advisory(
        id="legacy-env-names",
        severity="warning",
        summary=f"{len(names)} environment {noun}.",
        detail=(
            "The old names keep working until 1.0. Rename them in your compose "
            "file or .env and restart. Setting both names to different values "
            "stops startup."
        ),
        remedy=renames,
    )


def error_headline(message: str) -> str:
    """The first line of a write error without its exception class prefixes
    or the values it quotes.

    SQLAlchemy wraps the driver's sentence as "(module.Error) <class '...'>:
    sentence" and appends the SQL and its parameters on later lines. asyncpg
    quotes the bound value on the first line ("invalid input for query
    argument $4: '/login?token=...'"), and Postgres quotes rejected input
    after a colon, so this cuts the value after a query argument and hides
    quoted literals. Double-quoted column and relation names stay.
    """
    headline = message.strip().split("\n", 1)[0]
    while True:
        stripped = _CLASS_PREFIX.sub("", _EXCEPTION_PREFIX.sub("", headline)).strip()
        if stripped == headline:
            break
        headline = stripped
    headline = _QUERY_ARGUMENT_VALUE.sub(r"\1", headline)
    headline = _SINGLE_QUOTED.sub("'…'", headline)
    return _VALUE_AFTER_COLON.sub(': "…"', headline)


def last_write_error_sentence(message: str | None) -> str | None:
    """'The last error was: ...' for an advisory detail; None without a message.

    Only for views behind a login: even redacted, an error can name users or
    internal hosts, and /health is public.
    """
    headline = error_headline(message or "")
    if not headline:
        return None
    return f"The last error was: {headline if headline.endswith('.') else headline + '.'}"
