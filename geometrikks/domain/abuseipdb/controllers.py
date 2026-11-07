"""AbuseIPDB endpoints: availability, the stored reports, IP checks and sending a report."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, cast

from litestar import Controller, Request, get, post
from litestar.di import NamedDependency, Provide
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import JSONBody, QueryParameter, SkipValidation
from litestar.status_codes import (
    HTTP_200_OK,
    HTTP_400_BAD_REQUEST,
    HTTP_403_FORBIDDEN,
    HTTP_404_NOT_FOUND,
    HTTP_429_TOO_MANY_REQUESTS,
    HTTP_502_BAD_GATEWAY,
)

from geometrikks.config.settings import Settings
from geometrikks.domain.abuseipdb.dependencies import provide_abuseipdb_client, provide_abuseipdb_reports
from geometrikks.domain.abuseipdb.errors import AbuseIpdbDisabledError
from geometrikks.domain.abuseipdb.models import AbuseIpdbReport, ReporterKind, ReportStatus
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbReportRepository
from geometrikks.domain.abuseipdb.schemas import (
    AbuseIpdbStatusResponse,
    CheckResponse,
    RateLimitDTO,
    ReportBatchInput,
    ReportBatchResponse,
    ReportedIpDTO,
    ReportItemResult,
    StoredReportDTO,
)
from geometrikks.domain.abuseipdb.service import (
    REPORTED_IPS_WINDOW,
    ReportSubmission,
    normalize_public_ip,
    reporter_from_user,
    submit_report,
    upstream_http_error,
)
from geometrikks.server.exceptions import ErrorEnvelope
from geometrikks.server.logging import get_logger
from geometrikks.services.abuseipdb import (
    AbuseIpdbAuthError,
    AbuseIpdbClient,
    AbuseIpdbRateLimitedError,
    AbuseIpdbRejectedError,
    AbuseIpdbUnavailableError,
    CheckResult,
    RateLimit,
)

logger = get_logger(__name__)

IpAddressParam = Annotated[
    str,
    QueryParameter(
        name="ipAddress",
        description="The IP, IPv4 or IPv6. A private, reserved or malformed address gets a 400.",
    ),
]


def _error(description: str) -> ResponseSpec:
    return ResponseSpec(data_container=ErrorEnvelope, description=description)


def _rate_limit_dto(rate_limit: RateLimit | None) -> RateLimitDTO | None:
    if rate_limit is None:
        return None
    return RateLimitDTO(limit=rate_limit.limit, remaining=rate_limit.remaining, resets_at=rate_limit.resets_at)


def _stored_report_dto(report: AbuseIpdbReport) -> StoredReportDTO:
    return StoredReportDTO(
        id=report.id,
        ip_address=report.ip_address,
        categories=list(report.categories),
        comment=report.comment,
        attack_time=report.attack_time,
        status=cast(ReportStatus, report.status),
        reported_at=report.reported_at,
        abuse_confidence_score=report.abuse_confidence_score,
        reporter_kind=cast(ReporterKind, report.reporter_kind),
        reporter_name=report.reporter_name,
    )


def _check_response(result: CheckResult) -> CheckResponse:
    return CheckResponse(
        ip_address=result.ip_address,
        abuse_confidence_score=result.abuse_confidence_score,
        total_reports=result.total_reports,
        num_distinct_users=result.num_distinct_users,
        last_reported_at=result.last_reported_at,
        usage_type=result.usage_type,
        isp=result.isp,
        domain=result.domain,
        is_tor=result.is_tor,
        is_whitelisted=result.is_whitelisted,
        country_code=result.country_code,
    )


async def _check(client: AbuseIpdbClient, ip: str) -> CheckResult:
    try:
        return await client.check(ip)
    except (AbuseIpdbRateLimitedError, AbuseIpdbRejectedError, AbuseIpdbAuthError, AbuseIpdbUnavailableError) as error:
        raise upstream_http_error(error, quota="check") from error


class AbuseIpdbController(Controller):
    """IP checks against AbuseIPDB and abuse reports sent to it."""

    path = "/abuseipdb"
    tags = ["AbuseIPDB"]
    dependencies = {
        "abuseipdb_reports": Provide(provide_abuseipdb_reports),
        "abuseipdb": Provide(provide_abuseipdb_client, sync_to_thread=False),
    }

    @get(
        "/status",
        summary="Show whether AbuseIPDB checks and reports are available",
        description=(
            "Says whether ABUSEIPDB_API_KEY is set, which enables checks, and whether "
            "ABUSEIPDB_REPORTING_ENABLED=true, which enables reports. The quotas come from AbuseIPDB's latest "
            "answer to each kind of request since startup and are null before the first one. Nothing leaves the "
            "server."
        ),
    )
    async def get_abuseipdb_status(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
        abuseipdb: NamedDependency[SkipValidation[AbuseIpdbClient | None]],
    ) -> AbuseIpdbStatusResponse:
        return AbuseIpdbStatusResponse(
            enabled=settings.abuseipdb.enabled,
            reporting_enabled=settings.abuseipdb.reporting_enabled,
            reports=_rate_limit_dto(abuseipdb.rate_limit("report")) if abuseipdb else None,
            checks=_rate_limit_dto(abuseipdb.rate_limit("check")) if abuseipdb else None,
        )

    @get(
        "/reported-ips",
        summary="List the IPs reported to AbuseIPDB in the last 90 days",
        description=(
            "Returns each IP reported from GeoMetrikks in the last 90 days with the time and status of its "
            "latest report. Read from the local database; nothing leaves the server."
        ),
    )
    async def list_reported_ips(
        self,
        abuseipdb_reports: NamedDependency[SkipValidation[AbuseIpdbReportRepository]],
    ) -> list[ReportedIpDTO]:
        reported = await abuseipdb_reports.reported_ips(datetime.now(UTC) - REPORTED_IPS_WINDOW)
        return [
            ReportedIpDTO(ip_address=row.ip_address, reported_at=row.reported_at, status=row.status)
            for row in reported
        ]

    @get(
        "/reports",
        summary="List the reports sent to AbuseIPDB for an IP",
        description=(
            "Returns every report sent from GeoMetrikks for the IP, newest first, with its categories, comment "
            "and who sent it. Read from the local database; nothing leaves the server."
        ),
        responses={HTTP_400_BAD_REQUEST: _error("ipAddress is not a public IP address.")},
    )
    async def list_reports(
        self,
        abuseipdb_reports: NamedDependency[SkipValidation[AbuseIpdbReportRepository]],
        ip_address: IpAddressParam,
    ) -> list[StoredReportDTO]:
        reports = await abuseipdb_reports.list_for_ip(normalize_public_ip(ip_address))
        return [_stored_report_dto(report) for report in reports]

    @get(
        "/check",
        summary="Check an IP on AbuseIPDB",
        description=(
            "Asks AbuseIPDB what it knows about the IP: its confidence score, report counts, usage type and ISP. "
            "Only the IP leaves the server, and each answer is cached for 15 minutes, so a repeat check spends "
            "nothing from the daily quota. A private or reserved address gets a 400 without a request."
        ),
        responses={
            HTTP_400_BAD_REQUEST: _error("ipAddress is not a public IP address, or AbuseIPDB rejected it."),
            HTTP_404_NOT_FOUND: _error("ABUSEIPDB_API_KEY is not set."),
            HTTP_429_TOO_MANY_REQUESTS: _error("AbuseIPDB's check limit is used up. Retry-After says when to retry."),
            HTTP_502_BAD_GATEWAY: _error("AbuseIPDB could not be reached or rejected ABUSEIPDB_API_KEY."),
        },
    )
    async def check_ip(
        self,
        abuseipdb: NamedDependency[SkipValidation[AbuseIpdbClient | None]],
        ip_address: IpAddressParam,
    ) -> CheckResponse:
        if abuseipdb is None:
            raise AbuseIpdbDisabledError
        ip = normalize_public_ip(ip_address)
        result = await _check(abuseipdb, ip)
        logger.info("abuseipdb_check", ip_address=ip, score=result.abuse_confidence_score)
        return _check_response(result)

    @post(
        "/reports",
        status_code=HTTP_200_OK,
        summary="Report an IP to AbuseIPDB",
        description=(
            "Sends the IP, the categories, the comment and the attack time to AbuseIPDB, which publishes them on "
            "the IP's page. GeoMetrikks records the report first and keeps it as `unconfirmed` when AbuseIPDB's "
            "answer does not settle whether it landed. Needs ABUSEIPDB_REPORTING_ENABLED=true and a session or a "
            "read-write API key. An IP reported in the last 15 minutes gets a 429."
        ),
        responses={
            HTTP_400_BAD_REQUEST: _error(
                "The body is invalid, the IP is not public, the attack time is in the future, or AbuseIPDB "
                "rejected the report."
            ),
            HTTP_403_FORBIDDEN: _error("Reporting is off, or the API key is read-only."),
            HTTP_429_TOO_MANY_REQUESTS: _error(
                "The IP was reported in the last 15 minutes, or AbuseIPDB's report limit is used up. "
                "Retry-After says when to retry."
            ),
            HTTP_502_BAD_GATEWAY: _error(
                "AbuseIPDB could not be reached, refused ABUSEIPDB_API_KEY, or did not confirm the report. "
                "Code `abuseipdb_unconfirmed` means it may have been sent."
            ),
        },
    )
    async def create_reports(
        self,
        request: Request[Any, Any, Any],
        data: JSONBody[ReportBatchInput],
        settings: NamedDependency[SkipValidation[Settings]],
        abuseipdb: NamedDependency[SkipValidation[AbuseIpdbClient | None]],
        abuseipdb_reports: NamedDependency[SkipValidation[AbuseIpdbReportRepository]],
    ) -> ReportBatchResponse:
        report_input = data.reports[0]
        report = await submit_report(
            ReportSubmission(
                ip_address=report_input.ip_address,
                categories=report_input.categories,
                comment=report_input.comment,
                attack_time=report_input.attack_time,
            ),
            reporter=reporter_from_user(request.scope.get("user")),
            repository=abuseipdb_reports,
            client=abuseipdb,
            reporting_enabled=settings.abuseipdb.reporting_enabled,
            now=datetime.now(UTC),
        )
        return ReportBatchResponse(
            results=[
                ReportItemResult(
                    ip_address=report.ip_address,
                    status="reported",
                    abuse_confidence_score=report.abuse_confidence_score,
                    reported_at=report.reported_at,
                    error=None,
                )
            ]
        )
