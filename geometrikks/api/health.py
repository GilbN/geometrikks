"""Health (liveness) and readiness endpoints.

/health is safe for container HEALTHCHECK / LB probes: it returns 200 as
long as the app process serves requests; component states live in the
payload and never flip the status code. /health/ready returns 503 until
the database answers, for orchestrators that want a real readiness gate.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from litestar import Request, Response, get
from litestar.di import NamedDependency, Provide
from litestar.params import SkipValidation
from litestar.status_codes import HTTP_200_OK, HTTP_503_SERVICE_UNAVAILABLE
from sqlalchemy import text

from geometrikks.config.settings import Settings
from geometrikks.lib.utils import geoip_info
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.api.dependencies import provide_ingestion_service as pis


async def _database_reachable(timeout: float = 2.0) -> bool:
    """SELECT 1 with a short timeout; False on any failure."""
    import asyncio

    from geometrikks.server.plugins import get_sqlalchemy_config

    try:
        async def _probe() -> None:
            async with get_sqlalchemy_config().get_engine().connect() as conn:
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
) -> dict[str, Any]:
    """Liveness + component detail. Always 200 while the app is up."""
    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    is_running = ingestion_service.is_running if ingestion_service else False
    # Tailed files that disappeared mid-flight: the tailer keeps waiting for
    # them (log rotation resilience), so `running` stays true, but nothing is
    # being ingested from those files and status must not read as healthy.
    missing_files = ingestion_service.missing_files if ingestion_service else []
    db_reachable = await _database_reachable()

    poller = getattr(request.app.state, "crowdsec_stream_poller", None)

    return {
        # geoip does not flip status on its own: without a GeoLite2 database
        # file, ingestion refuses to start and ingestion.running reflects that.
        "status": "healthy"
        if (is_running and db_reachable and not missing_files)
        else "degraded",
        "started_at": _iso(getattr(request.app.state, "started_at", None)),
        "ingestion": {
            "running": is_running,
            "parsed_lines": ingestion_service.parsed_lines if ingestion_service else 0,
            "pending_records": ingestion_service.pending_records if ingestion_service else 0,
            "missing_files": missing_files,
            "last_record_at": _iso(
                ingestion_service.last_record_at if ingestion_service else None
            ),
        },
        "database": {"reachable": db_reachable},
        # build_date comes from the mmdb metadata (geoip_info), the actual
        # GeoLite2 build, not the file's mtime.
        "geoip": {
            "available": getattr(request.app.state, "geoip_available", True),
            "db_build_date": _iso(geoip_info(settings.geoip.db_path).build_date),
        },
        # CrowdSec is an optional integration: a down LAPI never flips
        # `status`. lapi_reachable is the stream poller's cached verdict;
        # null when disabled, DB-degraded, or before the first poll.
        "crowdsec": {
            "enabled": getattr(request.app.state, "crowdsec_service", None) is not None,
            "lapi_reachable": poller.lapi_reachable if poller is not None else None,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@get("/health/ready", tags=["Health"])
async def health_ready() -> Response[dict[str, Any]]:
    """Readiness: 200 only when the database answers."""
    if await _database_reachable():
        return Response({"ready": True}, status_code=HTTP_200_OK)
    return Response({"ready": False}, status_code=HTTP_503_SERVICE_UNAVAILABLE)
