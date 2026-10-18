"""Stats API endpoint for log parser statistics."""
from __future__ import annotations

import msgspec

from litestar import get
from litestar.di import NamedDependency, Provide

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logsources import LokiSource
from geometrikks.domain.system.dependencies import provide_ingestion_service as pis


class LokiSourceStats(msgspec.Struct, rename="camel"):
    """One LOKI_QUERIES entry as the ingestion service sees it.

    The selector and the server name describe the operator's log setup, so they
    are served here, behind auth, and never on /health.
    """

    query: str
    label: str
    server: str
    available: bool
    reason: str | None
    # Detected (auto) or pinned format; None until the first line is read.
    log_format: str | None
    parsed_lines: int


class IngestionStatsResponse(msgspec.Struct, rename="camel"):
    total_parsed_lines: int
    total_skipped_lines: int
    total_pending_records: int
    total_ignored_lines: int
    total_processed: int
    is_running: bool
    loki_sources: list[LokiSourceStats] = msgspec.field(default_factory=list)


def _loki_sources(service: LogIngestionService) -> list[LokiSourceStats]:
    sources: list[LokiSourceStats] = []
    for log_input in service.inputs:
        source = log_input.source
        if not isinstance(source, LokiSource):
            continue
        status = source.status()
        parser = log_input.parser
        sources.append(
            LokiSourceStats(
                query=source.query,
                label=source.label,
                server=service.server_for(log_input),
                available=status.available,
                reason=status.reason,
                log_format=parser.format.name if parser.format else None,
                parsed_lines=parser.parsed_lines,
            )
        )
    return sources


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
        loki_sources=_loki_sources(ingestion_service),
    )
