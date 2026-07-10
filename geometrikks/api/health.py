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
from litestar.status_codes import HTTP_200_OK, HTTP_503_SERVICE_UNAVAILABLE
from sqlalchemy import text

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


@get("/health", dependencies={"ingestion_service": Provide(pis, sync_to_thread=False)})
async def health(
    request: Request, ingestion_service: NamedDependency[LogIngestionService | None]
) -> dict[str, Any]:
    """Liveness + component detail. Always 200 while the app is up."""
    is_running = ingestion_service.is_running if ingestion_service else False
    db_reachable = await _database_reachable()

    return {
        # geoip does not flip status on its own: without a GeoLite2 database
        # file, ingestion refuses to start and ingestion.running reflects that.
        "status": "healthy" if (is_running and db_reachable) else "degraded",
        "ingestion": {
            "running": is_running,
            "parsed_lines": ingestion_service.parsed_lines if ingestion_service else 0,
            "pending_records": ingestion_service.pending_records if ingestion_service else 0,
        },
        "database": {"reachable": db_reachable},
        "geoip": {"available": getattr(request.app.state, "geoip_available", True)},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@get("/health/ready")
async def health_ready() -> Response[dict[str, Any]]:
    """Readiness: 200 only when the database answers."""
    if await _database_reachable():
        return Response({"ready": True}, status_code=HTTP_200_OK)
    return Response({"ready": False}, status_code=HTTP_503_SERVICE_UNAVAILABLE)
