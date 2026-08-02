"""Dependency providers for the system (operational) domain."""
from __future__ import annotations

from litestar import Request

from geometrikks.server import runtime
from geometrikks.services.ingestion import LogIngestionService


def provide_ingestion_service(request: Request) -> LogIngestionService | None:
    """Provide the LogIngestionService from app state.

    Returns None if the service is not available (degraded mode).
    """
    return runtime.get_ingestion_service(request.app)
