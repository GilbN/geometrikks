"""Wire shapes for abuse reports. Lists have no defaults (see TopUrlsResponse)."""
from __future__ import annotations

from typing import Literal

import msgspec


class ReportTarget(msgspec.Struct, rename="camel"):
    """What the report is about: one IP, or the IPs of one ASN."""

    kind: Literal["ip", "asn"]
    ip_address: str | None
    asn: int | None
    asn_organization: str | None


class ReportPeakDTO(msgspec.Struct, rename="camel"):
    """The IP's busiest hour or UTC day in the window."""

    timestamp: str
    hits: int


class ReportPathDTO(msgspec.Struct, rename="camel"):
    """A requested path with its hit and error counts."""

    url: str
    hits: int
    error_hits: int


class ReportUserAgentDTO(msgspec.Struct, rename="camel"):
    """A user agent the IP sent, with its hit count."""

    user_agent: str
    hits: int


class ReportLineDTO(msgspec.Struct, rename="camel"):
    """One access-log line without the operator's vhost or referrer."""

    timestamp: str
    method: str | None
    url: str | None
    http_version: str | None
    status_code: int | None
    bytes_sent: int | None
    user_agent: str | None


class ReportDecisionDTO(msgspec.Struct, rename="camel"):
    """An active CrowdSec decision covering the IP."""

    type: str
    scope: str
    value: str
    origin: str
    scenario: str
    duration: str


class ReportAlertDecisionDTO(msgspec.Struct, rename="camel"):
    """A decision an alert produced, live or expired."""

    type: str
    duration: str
    expired: bool


class ReportAlertDTO(msgspec.Struct, rename="camel"):
    """A CrowdSec detection against the IP inside the window."""

    scenario: str
    kind: str | None
    created_at: str
    start_at: str | None
    stop_at: str | None
    events_count: int
    decisions: list[ReportAlertDecisionDTO]


class ReportIpDTO(msgspec.Struct, rename="camel"):
    """Everything the report says about one source IP."""

    ip_address: str
    country_code: str | None
    country_name: str | None
    asn: int | None
    asn_organization: str | None
    total_requests: int
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    total_bytes: int
    first_seen: str | None
    last_seen: str | None
    distinct_paths: int
    malformed_requests: int
    peak: ReportPeakDTO | None
    paths: list[ReportPathDTO]
    user_agents: list[ReportUserAgentDTO]
    lines: list[ReportLineDTO]
    decisions: list[ReportDecisionDTO]
    alerts: list[ReportAlertDTO]
    alerts_truncated: bool


CrowdSecReportStatus = Literal["disabled", "ok", "decisions-only", "unavailable"]


class ReportCrowdSec(msgspec.Struct, rename="camel"):
    """Whether CrowdSec data made it into the report.

    ``decisions-only`` means no machine credentials, so no alert history.
    ``unavailable`` means the LAPI failed; the report still carries the logs.
    """

    status: CrowdSecReportStatus
    message: str | None


class AbuseReportResponse(msgspec.Struct, rename="camel"):
    """Evidence for an abuse report, in UTC, with the operator's names removed.

    ``ipCount``, ``totalRequests`` and ``status4xx`` cover every IP of the
    target in the window; ``ips`` holds the busiest ``maxIps`` of them. ``redactions``
    counts the operator names and addresses scrubbed from paths and user agents.
    """

    target: ReportTarget
    start_date: str
    end_date: str
    generated_at: str
    granularity: Literal["hourly", "daily"]
    ip_count: int
    total_requests: int
    status_4xx: int = msgspec.field(name="status4xx")
    redactions: int
    crowdsec: ReportCrowdSec
    ips: list[ReportIpDTO]


class AbuseContactResponse(msgspec.Struct, rename="camel"):
    """RDAP answer for an IP or AS number: the holder and its abuse contact."""

    query: str
    kind: Literal["ip", "asn"]
    registry: str
    rdap_url: str
    name: str | None
    handle: str | None
    start_address: str | None
    end_address: str | None
    cidrs: list[str]
    country: str | None
    abuse_emails: list[str]
    abuse_name: str | None
