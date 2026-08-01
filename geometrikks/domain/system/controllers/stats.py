"""Stats API endpoint for log parser statistics."""
from __future__ import annotations

from dataclasses import dataclass

from litestar import get
from litestar.di import NamedDependency, Provide

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.domain.system.dependencies import provide_ingestion_service as pis


@dataclass
class IngestionStatsResponse:
    total_parsed_lines: int
    total_skipped_lines: int
    total_pending_records: int
    total_ignored_lines: int
    total_processed: int
    is_running: bool


@get(
    "/stats",
    tags=["Analytics"],
    dependencies={"ingestion_service": Provide(pis, sync_to_thread=False)},
)
async def stats(
    ingestion_service: NamedDependency[LogIngestionService | None],
) -> IngestionStatsResponse:
    """Get log parser and ingestion statistics.

    Returns zeros if the ingestion service is not available (degraded mode).
    """
    if ingestion_service is None:
        return IngestionStatsResponse(
            total_parsed_lines=0,
            total_skipped_lines=0,
            total_pending_records=0,
            total_ignored_lines=0,
            total_processed=0,
            is_running=False,
        )

    return IngestionStatsResponse(
        total_parsed_lines=ingestion_service.parsed_lines,
        total_skipped_lines=ingestion_service.skipped_lines,
        total_pending_records=ingestion_service.pending_records,
        total_ignored_lines=ingestion_service.ignored_lines,
        total_processed=ingestion_service.total_processed,
        is_running=ingestion_service.is_running,
    )
