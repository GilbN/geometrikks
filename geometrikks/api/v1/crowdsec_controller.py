"""CrowdSec API: status, active decisions with geo enrichment, ban stats.

All /api routes are session-authenticated by middleware. The whole feature
is gated on /status: when the integration is disabled (no LAPI URL/bouncer
key) the data endpoints return 404 and the frontend hides the page.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Annotated

from advanced_alchemy.extensions.litestar import filters
from advanced_alchemy.service import OffsetPagination
from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.exceptions import NotFoundException
from litestar.params import QueryParameter

from geometrikks.api.dependencies import (
    provide_crowdsec_service,
    provide_security_enrichment_repo,
)
from geometrikks.config.settings import get_settings
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import IpEnrichment
from geometrikks.services.crowdsec import CrowdSecService, Decision

# The CAPI community blocklist can hold tens of thousands of decisions; the
# decisions table shows local origins by default and CAPI/lists opt in via
# the origins filter. /stats still covers all origins.
DEFAULT_ORIGINS = "crowdsec,cscli,geometrikks"

TOP_SCENARIO_LIMIT = 10


@dataclass
class CrowdSecStatusResponse:
    enabled: bool
    write_enabled: bool
    lapi_reachable: bool


@dataclass
class DecisionView:
    id: int | None
    ip: str  # Decision value; a CIDR/country/AS number for non-Ip scopes
    type: str
    scope: str
    origin: str
    scenario: str
    duration: str
    # enrichment from GeoMetrikks' own data (None for non-Ip scopes):
    country_code: str | None
    country_name: str | None
    city: str | None
    request_count_24h: int | None


@dataclass
class OriginCount:
    origin: str
    count: int


@dataclass
class ScenarioCount:
    scenario: str
    count: int


@dataclass
class CrowdSecStatsResponse:
    total: int
    by_origin: list[OriginCount]
    top_scenarios: list[ScenarioCount]


def _to_view(decision: Decision, enrichment: IpEnrichment | None) -> DecisionView:
    is_ip_scope = decision.scope == "Ip"
    return DecisionView(
        id=decision.id,
        ip=decision.value,
        type=decision.type,
        scope=decision.scope,
        origin=decision.origin,
        scenario=decision.scenario,
        duration=decision.duration,
        country_code=enrichment.country_code if enrichment else None,
        country_name=enrichment.country_name if enrichment else None,
        city=enrichment.city if enrichment else None,
        request_count_24h=(
            enrichment.request_count_24h if enrichment else (0 if is_ip_scope else None)
        ),
    )


def _require_service(crowdsec: CrowdSecService | None) -> CrowdSecService:
    if crowdsec is None:
        raise NotFoundException(detail="CrowdSec integration is not enabled")
    return crowdsec


class CrowdSecController(Controller):
    """CrowdSec decision views and ban statistics."""

    path = "/api/v1/crowdsec"
    tags = ["CrowdSec"]
    dependencies = {
        "crowdsec": Provide(provide_crowdsec_service, sync_to_thread=False),
        "enrichment_repo": Provide(provide_security_enrichment_repo),
    }

    @get("/status")
    async def get_status(
        self, crowdsec: NamedDependency[CrowdSecService | None]
    ) -> CrowdSecStatusResponse:
        """Integration state; the frontend gates the security page on this."""
        if crowdsec is None:
            return CrowdSecStatusResponse(
                enabled=False, write_enabled=False, lapi_reachable=False
            )
        return CrowdSecStatusResponse(
            enabled=True,
            write_enabled=get_settings().crowdsec.write_enabled,
            lapi_reachable=await crowdsec.ping(),
        )

    @get("/decisions")
    async def list_decisions(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        limit_offset: NamedDependency[filters.LimitOffset],
        origins: Annotated[str | None, QueryParameter(required=False)] = None,
    ) -> OffsetPagination[DecisionView]:
        """Active decisions, geo-enriched per displayed page.

        Pagination slices locally: the LAPI has no pagination of its own.
        Only the sliced page is enriched, so an opted-in CAPI blocklist
        (tens of thousands of decisions) never hits the database join.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions(origins=origins or DEFAULT_ORIGINS)
        page = decisions[limit_offset.offset : limit_offset.offset + limit_offset.limit]

        page_ips = [d.value for d in page if d.scope == "Ip"]
        enriched = await enrichment_repo.enrich(page_ips) if page_ips else {}
        return OffsetPagination(
            items=[_to_view(d, enriched.get(d.value)) for d in page],
            limit=limit_offset.limit,
            offset=limit_offset.offset,
            total=len(decisions),
        )

    @get("/decisions/lookup")
    async def lookup_decisions(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        ip: Annotated[str, QueryParameter(description="IP address to look up")],
    ) -> list[DecisionView]:
        """Decisions for one IP (log-row and map popovers, banned badges).

        No enrichment: the caller already has the row's geo context.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions_for_ip(ip)
        return [_to_view(d, None) for d in decisions]

    @get("/stats")
    async def get_stats(
        self, crowdsec: NamedDependency[CrowdSecService | None]
    ) -> CrowdSecStatsResponse:
        """Decision counts by origin and top scenarios, across all origins."""
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        origin_counts = Counter(d.origin for d in decisions)
        scenario_counts = Counter(d.scenario for d in decisions)
        return CrowdSecStatsResponse(
            total=len(decisions),
            by_origin=[
                OriginCount(origin=origin, count=count)
                for origin, count in origin_counts.most_common()
            ],
            top_scenarios=[
                ScenarioCount(scenario=scenario, count=count)
                for scenario, count in scenario_counts.most_common(TOP_SCENARIO_LIMIT)
            ],
        )
