"""Wire shapes for the AbuseIPDB endpoints."""
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

import msgspec
from msgspec import Meta

from geometrikks.domain.abuseipdb.models import ReporterKind, ReportStatus

IN_UTC = "as ISO 8601 in UTC"
StatusField = Annotated[
    ReportStatus,
    Meta(
        description=(
            "`sent` once AbuseIPDB accepted the report. `unconfirmed` when AbuseIPDB did not confirm it, "
            "so it may have been sent."
        )
    ),
]


class RateLimitDTO(msgspec.Struct, rename="camel", kw_only=True):
    """The daily quota AbuseIPDB reported on its latest answer for one endpoint."""

    limit: Annotated[int, Meta(description="Requests allowed per day.")]
    remaining: Annotated[int, Meta(description="Requests left today.")]
    resets_at: Annotated[datetime | None, Meta(description=f"When the quota resets, {IN_UTC}.")]


class AbuseIpdbStatusResponse(msgspec.Struct, rename="camel", kw_only=True):
    """Whether checks and reports are available, and the quota left for each."""

    enabled: Annotated[bool, Meta(description="True when ABUSEIPDB_API_KEY is set, so checks work.")]
    reporting_enabled: Annotated[
        bool, Meta(description="True when ABUSEIPDB_REPORTING_ENABLED=true, so reports can be sent.")
    ]
    blacklist_enabled: Annotated[
        bool,
        Meta(
            description=(
                "True when ABUSEIPDB_BLACKLIST_ENABLED=true, so the blacklist is downloaded, or read from "
                "ABUSEIPDB_BLACKLIST_FILE, and marked."
            )
        ),
    ]
    reports: Annotated[
        RateLimitDTO | None,
        Meta(description="The report quota from AbuseIPDB's latest answer. Null until a report since startup."),
    ]
    checks: Annotated[
        RateLimitDTO | None,
        Meta(description="The check quota from AbuseIPDB's latest answer. Null until a check since startup."),
    ]


class AbuseIpdbBlacklistResponse(msgspec.Struct, rename="camel", kw_only=True):
    """The IPs on AbuseIPDB's blacklist, as of the last download or file read."""

    generated_at: Annotated[
        datetime | None,
        Meta(
            description=(
                f"When AbuseIPDB generated the list, {IN_UTC}. For a plaintext ABUSEIPDB_BLACKLIST_FILE, when the "
                "file was last written. Null when `ips` is empty."
            )
        ),
    ]
    refreshed_at: Annotated[
        datetime | None,
        Meta(
            description=(
                f"When GeoMetrikks downloaded the list, {IN_UTC}. With ABUSEIPDB_BLACKLIST_FILE, when the file was "
                "last written. Null when `ips` is empty."
            )
        ),
    ]
    ips: Annotated[list[str], Meta(description="The listed IPs in their canonical spelling.")]


class ReportedIpDTO(msgspec.Struct, rename="camel", kw_only=True):
    """An IP reported from GeoMetrikks, with its latest report."""

    ip_address: Annotated[str, Meta(description="The reported IP.")]
    reported_at: Annotated[datetime, Meta(description=f"When the latest report was sent, {IN_UTC}.")]
    status: StatusField


class StoredReportDTO(msgspec.Struct, rename="camel", kw_only=True):
    """A report sent from GeoMetrikks, as stored."""

    id: Annotated[UUID, Meta(description="The stored report's ID.")]
    ip_address: Annotated[str, Meta(description="The reported IP.")]
    categories: Annotated[list[int], Meta(description="The AbuseIPDB category IDs, from 1 to 23.")]
    comment: Annotated[str, Meta(description="The comment sent with the report. It is public on AbuseIPDB.")]
    attack_time: Annotated[datetime, Meta(description=f"When the attack happened, {IN_UTC}.")]
    status: StatusField
    reported_at: Annotated[datetime, Meta(description=f"When the report was sent, {IN_UTC}.")]
    abuse_confidence_score: Annotated[
        int | None,
        Meta(description="The IP's confidence score from 0 to 100 that AbuseIPDB answered with. Null if unconfirmed."),
    ]
    reporter_kind: Annotated[
        ReporterKind,
        Meta(description="Who sent it: `user` for a login, `api_key`, or `anonymous` with auth disabled."),
    ]
    reporter_name: Annotated[
        str | None, Meta(description="The username or API key name at the time. Null for `anonymous`.")
    ]


class CheckResponse(msgspec.Struct, rename="camel", kw_only=True):
    """What AbuseIPDB knows about an IP."""

    ip_address: Annotated[str, Meta(description="The checked IP.")]
    abuse_confidence_score: Annotated[int, Meta(description="AbuseIPDB's confidence from 0 to 100 that it is abusive.")]
    total_reports: Annotated[int, Meta(description="Reports on the IP in the last 30 days.")]
    num_distinct_users: Annotated[int, Meta(description="Distinct AbuseIPDB users behind those reports.")]
    last_reported_at: Annotated[datetime | None, Meta(description=f"The newest report, {IN_UTC}. Null if none.")]
    usage_type: Annotated[str | None, Meta(description="AbuseIPDB's usage type, such as `Data Center/Web Hosting/Transit`.")]
    isp: Annotated[str | None, Meta(description="The ISP AbuseIPDB names.")]
    domain: Annotated[str | None, Meta(description="The domain AbuseIPDB ties to the IP.")]
    is_tor: Annotated[bool, Meta(description="True when the IP is a Tor exit node.")]
    is_whitelisted: Annotated[
        bool | None, Meta(description="True when AbuseIPDB whitelists the IP. Null when AbuseIPDB does not say.")
    ]
    country_code: Annotated[str | None, Meta(description="The ISO 3166-1 alpha-2 country code AbuseIPDB names.")]


class ReportItemInput(msgspec.Struct, rename="camel", kw_only=True, forbid_unknown_fields=True):
    """One report to send to AbuseIPDB. Every field becomes public there."""

    ip_address: Annotated[str, Meta(description="The IP to report. It must be public.")]
    categories: Annotated[
        list[Annotated[int, Meta(ge=1, le=23)]],
        Meta(min_length=1, max_length=23, description="AbuseIPDB category IDs from 1 to 23, each once."),
    ]
    comment: Annotated[
        str,
        Meta(min_length=1, max_length=1024, description="The report text, 1 to 1,024 characters, without NUL."),
    ]
    attack_time: Annotated[
        datetime, Meta(description="When the attack happened, as ISO 8601 with a timezone. Not in the future.")
    ]


class ReportBatchInput(msgspec.Struct, rename="camel", kw_only=True, forbid_unknown_fields=True):
    """The reports to send. Exactly one for now."""

    reports: Annotated[list[ReportItemInput], Meta(min_length=1, max_length=1, description="Exactly one report.")]


class ReportItemResult(msgspec.Struct, rename="camel", kw_only=True):
    """The outcome of one report."""

    ip_address: Annotated[str, Meta(description="The reported IP, in its canonical spelling.")]
    status: Annotated[
        Literal["reported", "rejected"],
        Meta(
            description=(
                "`reported` once AbuseIPDB accepted the report. `rejected` is reserved for requests with more "
                "than one report, which the API does not take yet. A failed report comes back as an error response."
            )
        ),
    ]
    abuse_confidence_score: Annotated[
        int | None, Meta(description="The IP's confidence score from 0 to 100 that AbuseIPDB answered with.")
    ]
    reported_at: Annotated[datetime | None, Meta(description=f"When the report was sent, {IN_UTC}.")]
    error: Annotated[
        str | None,
        Meta(
            description=(
                "Why AbuseIPDB rejected the report, with `rejected`. Null when reported. A failed report comes "
                "back as an error response, so this is null today."
            )
        ),
    ]


class ReportBatchResponse(msgspec.Struct, rename="camel", kw_only=True):
    """One result per report, in request order."""

    results: Annotated[list[ReportItemResult], Meta(description="One result per submitted report.")]
