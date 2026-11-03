"""The small, authenticated dashboard overview."""

from __future__ import annotations

from litestar import Controller, Request, get
from litestar.di import NamedDependency, Provide
from litestar.params import SkipValidation
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.analytics.dependencies import provide_summary_stats_repo
from geometrikks.domain.analytics.repositories import SummaryStatsRepository
from geometrikks.domain.instances import services as instance_services
from geometrikks.domain.instances.views import InstancesResponse
from geometrikks.domain.integrations.schemas import IntegrationSummary
from geometrikks.domain.integrations.services import IntegrationSummaryService
from geometrikks.lib.time_ranges import Window, relative_range


def provide_summary_service(
    request: Request, db_session: NamedDependency[AsyncSession],
    settings: NamedDependency[SkipValidation[Settings]],
    summary_stats_repo: NamedDependency[SummaryStatsRepository],
) -> IntegrationSummaryService:
    """Share the request session with traffic and existing instance evaluation."""
    async def instances() -> InstancesResponse:
        return await instance_services.list_instances(
            db_session, instance_services.head_identity(request.app, settings),
        )

    return IntegrationSummaryService(
        app=request.app, settings=settings, session=db_session,
        traffic_repo=summary_stats_repo, instance_reader=instances,
    )


class IntegrationController(Controller):
    path = "/integration"
    tags = ["Integrations"]
    dependencies = {
        "summary_stats_repo": Provide(provide_summary_stats_repo),
        "summary_service": Provide(provide_summary_service, sync_to_thread=False),
    }

    @get(
        "/summary",
        summary="Get a compact dashboard overview",
        description=(
            "Traffic, instances, local ingestion and active CrowdSec decisions in one response. "
            "window defaults to 24h and supports up to 365 days. Traffic uses analytics/summary semantics, "
            "including whole aggregate buckets above 24 hours. latestEventAt is retained log time, not commit "
            "time. Agent freshness comes from heartbeats; local ingestion describes only this process. "
            "Each section has available, reason and data; unavailable data is null, not zero. "
            "Sections are observed sequentially. Database sections have a three-second deadline each and "
            "the CrowdSec count makes one LAPI request with a two-second deadline."
        ),
        response_headers={"Cache-Control": "no-store"},
    )
    async def summary(
        self, summary_service: NamedDependency[SkipValidation[IntegrationSummaryService]], window: Window = "24h",
    ) -> IntegrationSummary:
        return await summary_service.summary(relative_range(window if window is not None else "24h"))
