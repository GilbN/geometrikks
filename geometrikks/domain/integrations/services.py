"""Gather existing domain summaries without coupling dashboard callers to their APIs."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import msgspec
from litestar import Litestar
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.analytics.repositories import SummaryStatsRepository
from geometrikks.domain.analytics.summary import period_summary
from geometrikks.domain.instances.views import InstancesResponse
from geometrikks.domain.integrations.schemas import (
    CrowdSecSummary, InstanceSummary, InstancesSummary, IntegrationSummary, SummaryReason, SummarySection, TrafficSummary,
)
from geometrikks.domain.system.controllers.health import IngestionHealth, build_ingestion_health
from geometrikks.lib.time_ranges import TimeRange
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.session_store import _OUTAGE_ERRORS
from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError

logger = get_logger(__name__)
DATABASE_SECTION_TIMEOUT = 3.0
CROWDSEC_TIMEOUT = 2.0


class IntegrationSummaryService:
    """Read database sections sequentially because they share a request session."""

    def __init__(
        self, *, app: Litestar, settings: Settings, session: AsyncSession,
        traffic_repo: SummaryStatsRepository, instance_reader: Callable[[], Awaitable[InstancesResponse]],
    ) -> None:
        self.app = app
        self.settings = settings
        self.session = session
        self.traffic_repo = traffic_repo
        self.instance_reader = instance_reader
        self.database_available = runtime.is_db_available(app)
        self.database_unavailable_reason: SummaryReason = "services_inactive"

    async def _recover_database(self, section: str, error: BaseException) -> None:
        logger.warning("integration_summary_unavailable", section=section, error_type=type(error).__name__)
        try:
            async with asyncio.timeout(0.5):
                await self.session.rollback()
        except (*_OUTAGE_ERRORS, SQLAlchemyError):
            self.database_available = False
            self.database_unavailable_reason = "database_unavailable"

    async def _traffic(self, time_range: TimeRange) -> SummarySection[TrafficSummary]:
        if not self.database_available:
            return SummarySection(available=False, reason=self.database_unavailable_reason)
        try:
            async with asyncio.timeout(DATABASE_SECTION_TIMEOUT):
                stats = await self.traffic_repo.get_summary(time_range.start, time_range.end)
                latest = await self.traffic_repo.latest_event_at(time_range.start, time_range.end)
        except (*_OUTAGE_ERRORS, DBAPIError) as error:
            if (
                isinstance(error, DBAPIError)
                and not error.connection_invalidated
                and not isinstance(error, _OUTAGE_ERRORS)
            ):
                raise
            await self._recover_database("traffic", error)
            return SummarySection(available=False, reason="database_unavailable")
        return SummarySection(available=True, data=TrafficSummary(totals=period_summary(stats), latest_event_at=latest))

    async def _instances(self) -> SummarySection[InstancesSummary]:
        if not self.database_available:
            return SummarySection(available=False, reason=self.database_unavailable_reason)
        try:
            async with asyncio.timeout(DATABASE_SECTION_TIMEOUT):
                result = await self.instance_reader()
        except (*_OUTAGE_ERRORS, DBAPIError) as error:
            if (
                isinstance(error, DBAPIError)
                and not error.connection_invalidated
                and not isinstance(error, _OUTAGE_ERRORS)
            ):
                raise
            await self._recover_database("instances", error)
            return SummarySection(available=False, reason="database_unavailable")
        return SummarySection(available=True, data=InstancesSummary(
            checked_at=result.checked_at,
            total=len(result.instances),
            checking_in=sum(instance.checking_in for instance in result.instances),
            warning=sum(instance.status == "warning" for instance in result.instances),
            critical=sum(instance.status == "critical" for instance in result.instances),
            items=[InstanceSummary(
                instance_name=instance.instance_name, mode=instance.mode, checking_in=instance.checking_in,
                status=instance.status, last_seen=instance.last_seen,
                last_parsed_at=instance.health.ingestion.last_record_at if instance.health else None,
            ) for instance in result.instances],
        ))

    def _ingestion(self) -> SummarySection[IngestionHealth]:
        if not self.settings.logparser.enabled:
            return SummarySection(available=False, reason="disabled")
        service = runtime.get_ingestion_service(self.app)
        if service is None or not service.is_running:
            return SummarySection(available=False, reason="not_running")
        return SummarySection(available=True, data=build_ingestion_health(self.settings, service))

    async def _crowdsec(self) -> SummarySection[CrowdSecSummary]:
        if not self.settings.crowdsec.enabled:
            return SummarySection(available=False, reason="disabled")
        service = runtime.get_crowdsec_service(self.app)
        if service is None:
            return SummarySection(available=False, reason="not_started")
        try:
            async with asyncio.timeout(CROWDSEC_TIMEOUT):
                decisions = await service.get_decisions()
        except CrowdSecAuthError:
            return SummarySection(available=False, reason="crowdsec_credentials_rejected")
        except TimeoutError:
            return SummarySection(available=False, reason="crowdsec_timeout")
        except CrowdSecUnavailableError:
            return SummarySection(available=False, reason="crowdsec_unreachable")
        except (msgspec.DecodeError, ValueError):
            return SummarySection(available=False, reason="invalid_response")
        return SummarySection(available=True, data=CrowdSecSummary(
            active_decisions=len(decisions), write_enabled=self.settings.crowdsec.write_enabled,
            checked_at=datetime.now(UTC),
        ))

    async def summary(self, time_range: TimeRange) -> IntegrationSummary:
        """Keep available sections when another dependency is down or times out."""
        traffic = await self._traffic(time_range)
        instances = await self._instances()
        ingestion = self._ingestion()
        crowdsec = await self._crowdsec()
        return IntegrationSummary(
            generated_at=datetime.now(UTC), start_date=time_range.start, end_date=time_range.end,
            traffic=traffic, instances=instances, ingestion=ingestion, crowdsec=crowdsec,
        )
