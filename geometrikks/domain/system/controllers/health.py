"""Health (liveness) and readiness endpoints.

/health is safe for container HEALTHCHECK / LB probes: it returns 200 as
long as the app process serves requests; component states live in the
payload and never flip the status code. /health/ready returns 503 until
the database answers (and, in agent mode, until the startup schema gate
has passed), for orchestrators that want a real readiness gate.

Timestamps are pre-rendered ISO 8601 strings (datetime.isoformat), the
format this payload has always used on the wire.
"""
from __future__ import annotations

import msgspec
from datetime import datetime, timezone
from typing import Literal

from litestar import Litestar, Request, Response, get
from litestar.di import NamedDependency, Provide
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import SkipValidation
from litestar.status_codes import HTTP_200_OK, HTTP_503_SERVICE_UNAVAILABLE
from sqlalchemy import text

from geometrikks.config.settings import Settings
from geometrikks.lib.utils import geoip_info
from geometrikks.server import runtime
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.domain.system.dependencies import provide_ingestion_service as pis


class IngestionHealth(msgspec.Struct, rename="camel"):
    running: bool
    parsed_lines: int
    pending_records: int
    missing_files: list[str]
    last_record_at: str | None
    # Additive: kept alongside `running` for wire compatibility.
    status: Literal["running", "degraded", "disabled"] = "running"
    publish_dropped: int = 0


class DatabaseHealth(msgspec.Struct, rename="camel"):
    reachable: bool


class GeoIPHealth(msgspec.Struct, rename="camel"):
    available: bool
    db_build_date: str | None
    # Additive: optional ASN edition state; never flips overall status.
    asn_available: bool = False
    asn_db_build_date: str | None = None


class CrowdSecHealth(msgspec.Struct, rename="camel"):
    enabled: bool
    lapi_reachable: bool | None


class Advisory(msgspec.Struct, rename="camel"):
    """One operator-actionable warning; the status page renders a card per
    advisory, so producers must write user-facing text, not log lines."""

    id: str
    severity: Literal["warning", "critical"]
    summary: str
    detail: str | None = None
    remedy: str | None = None


class HealthResponse(msgspec.Struct, rename="camel"):
    status: Literal["healthy", "degraded"]
    started_at: str | None
    ingestion: IngestionHealth
    database: DatabaseHealth
    geoip: GeoIPHealth
    crowdsec: CrowdSecHealth
    timestamp: str
    # Additive: agent-mode reporting (Task 5/6). schema_wait is None in full
    # mode, since only agent startup ever sets app.state.schema_wait_result.
    mode: Literal["full", "agent"] = "full"
    schema_wait: str | None = None
    # Additive: generic operator advisories; empty when nothing needs
    # attention. Producers append here rather than growing bespoke fields.
    advisories: list[Advisory] = msgspec.field(default_factory=list)


class ReadinessResponse(msgspec.Struct, rename="camel"):
    ready: bool


async def _database_reachable(app: Litestar, timeout: float = 2.0) -> bool:
    """SELECT 1 against the app's database with a short timeout; False on any failure."""
    import asyncio

    from geometrikks.server.plugins import get_app_db_config

    try:
        async def _probe() -> None:
            async with get_app_db_config(app).get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(_probe(), timeout=timeout)
        return True
    except Exception:
        return False


def _collect_advisories(app: Litestar, settings: Settings) -> list[Advisory]:
    # app/settings parameters: ASN availability lives on app.state, unlike
    # the module-state hostname-pollution flag.
    from geometrikks.server import timescale

    advisories: list[Advisory] = []
    pollution = timescale.get_hostname_pollution()
    if pollution and pollution.polluted and not timescale.location_caggs_have_hostname():
        advisories.append(Advisory(
            id="hostname-pollution",
            severity="warning",
            summary=(
                f"{pollution.container_id_count} of {pollution.distinct_count} "
                "recording hostnames look like Docker container IDs; the map "
                "source filter runs unaggregated until you consolidate."
            ),
            detail=(
                "LOGPARSER_HOST_NAME was unset while running in Docker, so "
                "rotating container IDs were recorded as hostnames. The "
                "location-CAGG upgrade is skipped until the history is "
                "consolidated; restart afterwards to migrate."
            ),
            remedy="litestar backfill-hostname <hostname> --consolidate",
        ))
    if (
        settings.geoip.asn_enabled
        and runtime.is_geoip_available(app, default=True)
        and not runtime.is_asn_available(app, default=True)
    ):
        advisories.append(Advisory(
            id="asn-database-missing",
            severity="warning",
            summary=(
                "ASN enrichment is enabled but no GeoLite2 ASN database is "
                "loaded; new requests are ingested without ASN data."
            ),
            detail=(
                "The GeoLite2 ASN database could not be found or downloaded. "
                "It uses the same MaxMind credentials as the City database "
                "(MAXMINDDB_USER_ID / MAXMINDDB_LICENSE_KEY) and downloads "
                "automatically at startup and on the weekly refresh. Check the "
                "app log for the download error, then restart the container."
            ),
            remedy="Set GEOIP_ASN_ENABLED=false to turn ASN enrichment off instead.",
        ))
    return advisories


@get(
    "/health",
    tags=["Health"],
    dependencies={"ingestion_service": Provide(pis, sync_to_thread=False)},
)
async def health(
    request: Request,
    ingestion_service: NamedDependency[LogIngestionService | None],
    settings: NamedDependency[SkipValidation[Settings]],
) -> HealthResponse:
    """Liveness + component detail. Always 200 while the app is up."""
    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    is_running = ingestion_service.is_running if ingestion_service else False
    # Tailed files that disappeared mid-flight: the tailer keeps waiting for
    # them (log rotation resilience), so `running` stays true, but nothing is
    # being ingested from those files and status must not read as healthy.
    missing_files = ingestion_service.missing_files if ingestion_service else []
    db_reachable = await _database_reachable(request.app)

    poller = runtime.get_crowdsec_poller(request.app)

    # LOGPARSER_ENABLED=false is an operator choice, not an outage: it must
    # report "disabled", not "degraded", and must not flip overall status.
    ingestion_status: Literal["running", "degraded", "disabled"]
    if not settings.logparser.enabled:
        ingestion_status = "disabled"
    elif is_running:
        ingestion_status = "running"
    else:
        ingestion_status = "degraded"

    return HealthResponse(
        # geoip does not flip status on its own: without a GeoLite2 database
        # file, ingestion refuses to start and ingestion.running reflects that.
        status="healthy"
        if (db_reachable and not missing_files and ingestion_status != "degraded")
        else "degraded",
        started_at=_iso(runtime.get_started_at(request.app)),
        ingestion=IngestionHealth(
            running=is_running,
            parsed_lines=ingestion_service.parsed_lines if ingestion_service else 0,
            pending_records=ingestion_service.pending_records if ingestion_service else 0,
            missing_files=missing_files,
            last_record_at=_iso(
                ingestion_service.last_record_at if ingestion_service else None
            ),
            status=ingestion_status,
            publish_dropped=(
                ingestion_service.publish_dropped if ingestion_service else 0
            ),
        ),
        database=DatabaseHealth(reachable=db_reachable),
        # build_date comes from the mmdb metadata (geoip_info), the actual
        # GeoLite2 build, not the file's mtime.
        geoip=GeoIPHealth(
            # default=True: don't report degraded while startup is still running.
            available=runtime.is_geoip_available(request.app, default=True),
            db_build_date=_iso(geoip_info(settings.geoip.db_path).build_date),
            asn_available=(
                settings.geoip.asn_enabled
                and runtime.is_asn_available(request.app, default=True)
            ),
            asn_db_build_date=_iso(geoip_info(settings.geoip.asn_db_path).build_date),
        ),
        # CrowdSec is an optional integration: a down LAPI never flips
        # `status`. lapi_reachable is the stream poller's cached verdict;
        # null when disabled, DB-degraded, or before the first poll.
        crowdsec=CrowdSecHealth(
            enabled=runtime.get_crowdsec_service(request.app) is not None,
            lapi_reachable=poller.lapi_reachable if poller is not None else None,
        ),
        timestamp=datetime.now(timezone.utc).isoformat(),
        mode="agent" if settings.is_agent else "full",
        schema_wait=(
            getattr(request.app.state, "schema_wait_result", None)
            if settings.is_agent
            else None
        ),
        advisories=_collect_advisories(request.app, settings),
    )


@get(
    "/health/ready",
    tags=["Health"],
    responses={
        HTTP_503_SERVICE_UNAVAILABLE: ResponseSpec(
            data_container=ReadinessResponse,
            description=(
                "Database unreachable, or an agent whose schema gate has not "
                "passed; the app is not ready for traffic."
            ),
        )
    },
)
async def health_ready(
    request: Request,
    settings: NamedDependency[SkipValidation[Settings]],
) -> Response[ReadinessResponse]:
    """Readiness: the database answers and, in agent mode, the startup schema
    gate passed. A schema-timeout agent never starts ingestion, so it stays
    503 and an orchestrator restart re-runs the wait."""
    schema_gate_passed = (
        not settings.is_agent
        or getattr(request.app.state, "schema_wait_result", None) in ("ready", "newer")
    )
    if schema_gate_passed and await _database_reachable(request.app):
        return Response(ReadinessResponse(ready=True), status_code=HTTP_200_OK)
    return Response(ReadinessResponse(ready=False), status_code=HTTP_503_SERVICE_UNAVAILABLE)
