"""Builds the health report an instance writes into its heartbeat row."""
from collections import deque
from datetime import datetime

import msgspec
from litestar import Litestar

from geometrikks.config.settings import Settings
from geometrikks.domain.instances.schemas import (
    HeartbeatPayload,
    JobReport,
    LastErrorReport,
    SourceReport,
)
from geometrikks.domain.system.controllers.health import build_health_response
from geometrikks.server import runtime

JOB_ERROR_MAX_CHARS = 500


class RollingCounter:
    """Increase of a monotonic total over a trailing window.

    Keeps the newest sample at least window_seconds old as the baseline and
    everything after it, so memory stays bounded by the sample rate.
    """

    def __init__(self, window_seconds: float = 300.0) -> None:
        self._window_seconds = window_seconds
        self._samples: deque[tuple[float, int]] = deque()

    def sample(self, at_monotonic: float, total: int) -> int | None:
        """Record a reading; None until a sample a full window old exists."""
        self._samples.append((at_monotonic, total))
        while (
            len(self._samples) >= 2
            and at_monotonic - self._samples[1][0] >= self._window_seconds
        ):
            self._samples.popleft()
        baseline_at, baseline_total = self._samples[0]
        if at_monotonic - baseline_at < self._window_seconds:
            return None
        return total - baseline_total


def build_payload(
    app: Litestar,
    settings: Settings,
    *,
    lines_5m: int | None,
    failed_5m: int | None,
    recent_starts: list[datetime],
    name_conflict_at: datetime | None,
) -> HeartbeatPayload:
    ingestion_service = runtime.get_ingestion_service(app)
    health_response = build_health_response(
        app, settings, ingestion_service, db_reachable=True
    )

    jobs: list[JobReport] = []
    scheduler = runtime.get_scheduler(app)
    if scheduler is not None:
        tracker = runtime.get_scheduler_tracker(app)
        for job in scheduler.get_jobs():
            run_info = tracker.get(job.id)
            jobs.append(
                JobReport(
                    id=job.id,
                    name=job.name,
                    next_run_time=job.next_run_time,
                    last_start=run_info.last_start,
                    last_status=run_info.last_status,
                    last_error=(
                        run_info.last_error[:JOB_ERROR_MAX_CHARS]
                        if run_info.last_error
                        else None
                    ),
                )
            )

    sources: list[SourceReport] = []
    last_error: LastErrorReport | None = None
    if ingestion_service is not None:
        for log_input in ingestion_service.inputs:
            source_status = log_input.source.status()
            log_format = log_input.parser.format
            sources.append(
                SourceReport(
                    kind=log_input.source.kind,
                    label=log_input.source.label,
                    server_name=ingestion_service.server_for(log_input),
                    log_format=log_format.name if log_format else None,
                    available=source_status.available,
                    reason=source_status.reason,
                    parsed_lines=log_input.parser.parsed_lines,
                )
            )
        batch_error = ingestion_service.last_batch_error
        if batch_error is not None:
            last_error = LastErrorReport(message=batch_error.message, at=batch_error.at)

    return HeartbeatPayload(
        health=msgspec.to_builtins(health_response),
        jobs=jobs,
        last_error=last_error,
        lines_5m=lines_5m,
        failed_5m=failed_5m,
        recent_starts=recent_starts,
        name_conflict_at=name_conflict_at,
        server_names=settings.ingest_server_names(),
        sources=sources,
        instance_name_source=settings.instance_name_source,
    )
