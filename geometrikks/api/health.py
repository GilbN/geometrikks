"""Health check endpoint for service status monitoring."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from litestar import get
from litestar.di import Provide

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.api.dependencies import provide_ingestion_service as pis


@get("/health", dependencies={"ingestion_service": Provide(pis, sync_to_thread=False)})
async def health(ingestion_service: LogIngestionService | None) -> dict[str, Any]:
    """Get service health status.

    Returns:
        Dictionary with overall status and component health details.
        Useful for load balancers, Kubernetes probes, and frontend status indicators.
    """
    is_running = ingestion_service.is_running if ingestion_service else False

    return {
        "status": "healthy" if is_running else "degraded",
        "ingestion": {
            "running": is_running,
            "parsed_lines": ingestion_service.parsed_lines if ingestion_service else 0,
            "pending_records": ingestion_service.pending_records if ingestion_service else 0,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
