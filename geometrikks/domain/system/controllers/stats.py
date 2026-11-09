"""Stats API endpoint for log parser statistics."""
from __future__ import annotations

from typing import Annotated

import msgspec

from litestar import get
from litestar.di import NamedDependency, Provide

from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logsources import LokiSource
from geometrikks.domain.system.dependencies import provide_ingestion_service as pis


# The selector and the server name describe the operator's log setup, so
# they are served here, behind auth, and never on /health.
class LokiSourceStats(msgspec.Struct, rename="camel"):
    """One query from LOKI_QUERIES and how ingestion is reading it."""

    query: Annotated[str, msgspec.Meta(description="The LogQL selector as configured.")]
    label: Annotated[
        str,
        msgspec.Meta(
            description=(
                "`loki:` and the query's position in LOKI_QUERIES, counted from 1. `/health` names an "
                "unavailable source by this label."
            )
        ),
    ]
    server: Annotated[str, msgspec.Meta(description="The server name GeoMetrikks stores this query's lines under.")]
    available: Annotated[
        bool, msgspec.Meta(description="False while GeoMetrikks cannot reach Loki or Loki rejects the query.")
    ]
    reason: Annotated[
        str | None,
        msgspec.Meta(description="`unreachable` or `rejected` while the source is unavailable, otherwise null."),
    ]
    log_format: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The log format in use, such as `traefik-json`, either configured or detected from the lines. "
                "Null while a detected format has not been found yet."
            )
        ),
    ]
    parsed_lines: Annotated[int, msgspec.Meta(description="Lines from this query that parsed.")]


class IngestionStatsResponse(msgspec.Struct, rename="camel"):
    """The log ingestion counters of this process. They start at zero when the process starts."""

    total_parsed_lines: Annotated[int, msgspec.Meta(description="Log lines that parsed, across all sources.")]
    total_skipped_lines: Annotated[int, msgspec.Meta(description="Log lines that did not match the log format.")]
    total_pending_records: Annotated[
        int, msgspec.Meta(description="Parsed records held in memory until the next database write.")
    ]
    total_ignored_lines: Annotated[
        int, msgspec.Meta(description="Log lines GeoMetrikks dropped because the client IP is in LOGPARSER_IGNORE_IPS.")
    ]
    total_processed: Annotated[
        int, msgspec.Meta(description="Parsed records that ingestion has passed to a database write.")
    ]
    is_running: Annotated[
        bool,
        msgspec.Meta(
            description="False when LOGPARSER_ENABLED is false, or when ingestion failed to start or stopped."
        ),
    ]
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
    summary="Get the log ingestion counters",
    description=(
        "Returns the line and record counters of this process, and the state of each Loki query in "
        "LOKI_QUERIES. The counters start at zero when the process starts. Without an ingestion service, "
        "as with LOGPARSER_ENABLED=false, every counter is 0, `isRunning` is false and `lokiSources` is empty."
    ),
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
