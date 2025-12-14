"""Stats API endpoint for log parser statistics."""
from __future__ import annotations

from typing import Any

from litestar import get
from litestar.di import Provide

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.api.dependencies import provide_ingestion_service as pis


@get("/stats", dependencies={"ingestion_service": Provide(pis, sync_to_thread=False)})
async def stats(ingestion_service: LogIngestionService | None) -> dict[str, Any]:
    """Get log parser and ingestion statistics.

    Returns:
        Dictionary with parsing and ingestion statistics.
        Returns zeros if ingestion service is not available (degraded mode).
    """
    if ingestion_service is None:
        return {
            "total_parsed_lines": 0,
            "total_skipped_lines": 0,
            "total_pending_records": 0,
            "total_processed": 0,
            "is_running": False,
        }

    return {
        "total_parsed_lines": ingestion_service.parsed_lines,
        "total_skipped_lines": ingestion_service.skipped_lines,
        "total_pending_records": ingestion_service.pending_records,
        "total_processed": ingestion_service.total_processed,
        "is_running": ingestion_service.is_running,
    }
