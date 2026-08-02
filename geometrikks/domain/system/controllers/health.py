"""Health (liveness) and readiness endpoints.

/health is safe for container HEALTHCHECK / LB probes: it returns 200 as
long as the app process serves requests; component states live in the
payload and never flip the status code. /health/ready returns 503 until
the database answers, for orchestrators that want a real readiness gate.

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


class DatabaseHealth(msgspec.Struct, rename="camel"):
    reachable: bool


class GeoIPHealth(msgspec.Struct, rename="camel"):
    available: bool
    db_build_date: str | None


class CrowdSecHealth(msgspec.Struct, rename="camel"):
    enabled: bool
    lapi_reachable: bool | None


class HealthResponse(msgspec.Struct, rename="camel"):
    status: Literal["healthy", "degraded"]
    started_at: str | None
    ingestion: IngestionHealth
    database: DatabaseHealth
    geoip: GeoIPHealth
    crowdsec: CrowdSecHealth
    timestamp: str


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

    return HealthResponse(
        # geoip does not flip status on its own: without a GeoLite2 database
        # file, ingestion refuses to start and ingestion.running reflects that.
        status="healthy"
        if (is_running and db_reachable and not missing_files)
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
        ),
        database=DatabaseHealth(reachable=db_reachable),
        # build_date comes from the mmdb metadata (geoip_info), the actual
        # GeoLite2 build, not the file's mtime.
        geoip=GeoIPHealth(
            # default=True: don't report degraded while startup is still running.
            available=runtime.is_geoip_available(request.app, default=True),
            db_build_date=_iso(geoip_info(settings.geoip.db_path).build_date),
        ),
        # CrowdSec is an optional integration: a down LAPI never flips
        # `status`. lapi_reachable is the stream poller's cached verdict;
        # null when disabled, DB-degraded, or before the first poll.
        crowdsec=CrowdSecHealth(
            enabled=runtime.get_crowdsec_service(request.app) is not None,
            lapi_reachable=poller.lapi_reachable if poller is not None else None,
        ),
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


@get(
    "/health/ready",
    tags=["Health"],
    responses={
        HTTP_503_SERVICE_UNAVAILABLE: ResponseSpec(
            data_container=ReadinessResponse,
            description="Database unreachable; the app is not ready for traffic.",
        )
    },
)
async def health_ready(request: Request) -> Response[ReadinessResponse]:
    """Readiness: 200 only when the database answers."""
    if await _database_reachable(request.app):
        return Response(ReadinessResponse(ready=True), status_code=HTTP_200_OK)
    return Response(ReadinessResponse(ready=False), status_code=HTTP_503_SERVICE_UNAVAILABLE)
