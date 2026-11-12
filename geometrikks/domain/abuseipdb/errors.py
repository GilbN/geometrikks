"""HTTP errors for AbuseIPDB reporting, each with a stable ``code``."""
from __future__ import annotations

from litestar.exceptions import (
    ClientException,
    HTTPException,
    NotFoundException,
    PermissionDeniedException,
    TooManyRequestsException,
)
from litestar.status_codes import HTTP_502_BAD_GATEWAY


class ReportingDisabledError(PermissionDeniedException):
    code = "abuseipdb_reporting_disabled"
    detail = "Reporting requires ABUSEIPDB_REPORTING_ENABLED=true and ABUSEIPDB_API_KEY"


class AbuseIpdbDisabledError(NotFoundException):
    code = "abuseipdb_disabled"
    detail = "AbuseIPDB requires ABUSEIPDB_API_KEY"


class RecentReportError(TooManyRequestsException):
    code = "abuseipdb_recent_report"
    detail = "Reported less than 15 minutes ago"

    def __init__(self, retry_after: int) -> None:
        super().__init__(headers={"Retry-After": str(retry_after)})


class UpstreamRateLimitedError(TooManyRequestsException):
    code = "abuseipdb_rate_limited"

    def __init__(self, detail: str, *, retry_after: int | None) -> None:
        headers = None if retry_after is None else {"Retry-After": str(retry_after)}
        super().__init__(detail=detail, headers=headers)


class UpstreamRejectedError(ClientException):
    code = "abuseipdb_rejected"


class UpstreamFailedError(HTTPException):
    status_code = HTTP_502_BAD_GATEWAY
    code = "abuseipdb_failed"


class ReportUnconfirmedError(HTTPException):
    status_code = HTTP_502_BAD_GATEWAY
    code = "abuseipdb_unconfirmed"
    detail = "AbuseIPDB did not confirm the report. It may have been sent, and GeoMetrikks recorded it as unconfirmed."
