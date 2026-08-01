"""CrowdSec API: status, active decisions with geo enrichment, ban stats.

All /api routes are session-authenticated by middleware. The whole feature
is gated on /status: when the integration is disabled (no LAPI URL/bouncer
key) the data endpoints return 404 and the frontend hides the page.
"""

from __future__ import annotations

import re
from datetime import datetime
from collections import Counter
from dataclasses import dataclass
from typing import Annotated

from advanced_alchemy.extensions.litestar import filters
from advanced_alchemy.service import OffsetPagination
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency, Provide
from litestar.exceptions import NotFoundException, PermissionDeniedException
from litestar.params import QueryParameter, SkipValidation
from litestar.status_codes import HTTP_200_OK, HTTP_204_NO_CONTENT

from geometrikks.domain.security.dependencies import (
    provide_crowdsec_poller,
    provide_crowdsec_service,
    provide_limit_offset_pagination,
    provide_security_enrichment_repo,
)
from geometrikks.config.settings import Settings
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.lib.validation import validate_ip_address
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import IpEnrichment, IpLocation
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import CrowdSecService, Decision
from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

# The CAPI community blocklist can hold tens of thousands of decisions; the
# decisions table shows local origins by default and CAPI/lists opt in via
# the origins filter. /stats still covers all origins.
DEFAULT_ORIGINS = "crowdsec,cscli,geometrikks"

TOP_SCENARIO_LIMIT = 10

# Go duration string as the LAPI accepts it, e.g. "4h", "30m", "1h30m".
GO_DURATION_RE = re.compile(r"^(\d+h)?(\d+m)?(\d+s)?$")

logger = get_logger(__name__)


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


@dataclass
class AlertView:
    id: int | None
    scenario: str
    message: str
    events_count: int
    created_at: str
    machine_id: str | None
    scope: str
    value: str
    country: str | None
    as_name: str | None
    decision_count: int


@dataclass
class BanRequest:
    ip: str
    duration: str | None = None
    reason: str = "manual ban from GeoMetrikks"


@dataclass
class UnbanRequest:
    ip: str


@dataclass
class UnbanResponse:
    deleted: int


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


def _require_write(crowdsec: CrowdSecService | None, settings: Settings) -> CrowdSecService:
    service = _require_service(crowdsec)
    if not settings.crowdsec.write_enabled:
        raise PermissionDeniedException(
            detail="Ban/unban requires CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD"
        )
    return service


def _validate_duration(value: str) -> str:
    if not value or not GO_DURATION_RE.fullmatch(value):
        raise DomainValidationError(
            f"Invalid ban duration: {value!r} (expected a Go duration like 4h, 30m, 168h)"
        )
    return value


def _actor(request: Request) -> str:
    """Session username for the audit log; 'unknown' in auth-disabled mode."""
    user = request.scope.get("user")
    return str(user) if user else "unknown"


class CrowdSecController(Controller):
    """CrowdSec decision views and ban statistics."""

    path = "/api/v1/crowdsec"
    tags = ["CrowdSec"]
    dependencies = {
        "crowdsec": Provide(provide_crowdsec_service, sync_to_thread=False),
        "crowdsec_poller": Provide(provide_crowdsec_poller, sync_to_thread=False),
        "enrichment_repo": Provide(provide_security_enrichment_repo),
        # Controller-scoped: /decisions paginates an in-memory LAPI result,
        # not an ORM query, so it keeps the hand-written provider.
        "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
    }

    @get("/status")
    async def get_status(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        crowdsec_poller: NamedDependency[SkipValidation[CrowdSecStreamPoller | None]],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> CrowdSecStatusResponse:
        """Integration state; the frontend gates the security page on this."""
        if crowdsec is None:
            return CrowdSecStatusResponse(
                enabled=False, write_enabled=False, lapi_reachable=False
            )
        # The stream poller probes the LAPI every poll interval; its cached
        # verdict avoids a live ping per status request (which can block for
        # the full request timeout against a black-holed host). Live ping
        # remains the fallback when the poller is absent (DB-degraded mode)
        # or has not completed a poll yet.
        cached: bool | None = (
            crowdsec_poller.lapi_reachable if crowdsec_poller is not None else None
        )
        return CrowdSecStatusResponse(
            enabled=True,
            write_enabled=settings.crowdsec.write_enabled,
            lapi_reachable=cached if cached is not None else await crowdsec.ping(),
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
        validate_ip_address(ip)
        decisions = await service.get_decisions_for_ip(ip)
        return [_to_view(d, None) for d in decisions]

    @get("/banned-ips")
    async def list_banned_ips(
        self, crowdsec: NamedDependency[CrowdSecService | None]
    ) -> list[str]:
        """All actively banned IPs across every origin, values only.

        Feeds the frontend badge set: compact enough to ship even when a
        subscribed CAPI blocklist holds tens of thousands of decisions.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        # An IP can hold several decisions (e.g. a local scenario plus a
        # CAPI list); dict.fromkeys dedupes while keeping LAPI order.
        return list(dict.fromkeys(d.value for d in decisions if d.scope == "Ip"))

    @get("/banned-locations")
    async def list_banned_locations(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        from_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
        to_timestamp: Annotated[datetime | None, QueryParameter(required=False)] = None,
    ) -> list[IpLocation]:
        """Coordinates of banned IPs that appear in this server's own traffic.

        Feeds the map's banned overlay: the decision list (all origins) is
        joined against stored geo events, so only attackers actually seen
        here get a marker. The optional window keeps the overlay in step
        with the map's time range; it defaults to the 30d geo lookback.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        banned_ips = list(dict.fromkeys(d.value for d in decisions if d.scope == "Ip"))
        return await enrichment_repo.locations(
            banned_ips, start=from_timestamp, end=to_timestamp
        )

    @get("/alerts")
    async def list_alerts(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        settings: NamedDependency[SkipValidation[Settings]],
        limit: Annotated[int, QueryParameter(ge=1, le=500, required=False)] = 50,
        ip: Annotated[str | None, QueryParameter(required=False)] = None,
        scenario: Annotated[str | None, QueryParameter(required=False)] = None,
        since: Annotated[
            str | None,
            QueryParameter(required=False, description="Go duration lookback, e.g. 24h"),
        ] = None,
    ) -> list[AlertView]:
        """Recent alert history from the LAPI (machine credentials required).

        The LAPI only geo-enriches alerts from log-parsing scenarios; manual
        bans carry a bare IP. Ip-scope sources missing LAPI geo are filled
        from GeoMetrikks' own stored traffic instead.
        """
        service = _require_write(crowdsec, settings)
        if ip is not None:
            validate_ip_address(ip)
        if since is not None:
            _validate_duration(since)
        alerts = await service.get_alerts(limit=limit, ip=ip, scenario=scenario, since=since)

        bare_ips = [
            a.source.value for a in alerts if a.source.scope == "Ip" and a.source.cn is None
        ]
        enriched = await enrichment_repo.enrich(bare_ips) if bare_ips else {}

        def country_for(alert) -> str | None:
            if alert.source.cn is not None:
                return alert.source.cn
            enrichment = enriched.get(alert.source.value)
            if enrichment is None:
                return None
            return enrichment.country_name or enrichment.country_code

        return [
            AlertView(
                id=alert.id,
                scenario=alert.scenario,
                message=alert.message,
                events_count=alert.events_count,
                created_at=alert.created_at,
                machine_id=alert.machine_id,
                scope=alert.source.scope,
                value=alert.source.value,
                country=country_for(alert),
                as_name=alert.source.as_name,
                decision_count=len(alert.decisions),
            )
            for alert in alerts
        ]

    @post("/ban", status_code=HTTP_204_NO_CONTENT)
    async def ban(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        data: BanRequest,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> None:
        """Create a manual ban decision for one IP.

        Enforcement still depends on a bouncer attached to the LAPI.
        """
        service = _require_write(crowdsec, settings)
        validate_ip_address(data.ip)
        duration = data.duration and _validate_duration(data.duration)
        await service.ban_ip(data.ip, duration=duration, reason=data.reason)
        logger.info(
            "CrowdSec ban by %s: ip=%s duration=%s reason=%s",
            _actor(request),
            data.ip,
            duration or settings.crowdsec.default_ban_duration,
            data.reason,
        )

    @post("/unban", status_code=HTTP_200_OK)
    async def unban(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        data: UnbanRequest,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> UnbanResponse:
        """Delete all active decisions for one IP."""
        service = _require_write(crowdsec, settings)
        validate_ip_address(data.ip)
        deleted = await service.unban_ip(data.ip)
        logger.info(
            "CrowdSec unban by %s: ip=%s deleted=%d", _actor(request), data.ip, deleted
        )
        return UnbanResponse(deleted=deleted)

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
