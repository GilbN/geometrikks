"""Wire shapes for abuse reports."""
from __future__ import annotations

from typing import Annotated, Literal

import msgspec

# The lists have no defaults on purpose. A default makes the field optional in
# OpenAPI and in the generated TS client.

IN_UTC = "as ISO 8601 in UTC"
CrowdSecDuration = Annotated[
    str,
    msgspec.Meta(description="The time left, as a Go duration such as `3h59m12s`. Negative once it has expired."),
]


class ReportTarget(msgspec.Struct, rename="camel"):
    """What the report is about, one IP or the IPs of one ASN."""

    kind: Literal["ip", "asn"]
    ip_address: Annotated[str | None, msgspec.Meta(description="The IP. Null for an ASN report.")]
    asn: Annotated[
        int | None,
        msgspec.Meta(description="The ASN. For an IP report, the one its newest line with ASN data names."),
    ]
    asn_organization: str | None
    asn_drop: Annotated[bool, msgspec.Meta(description="True when the ASN is on the Spamhaus ASN-DROP list.")]


class ReportPeakDTO(msgspec.Struct, rename="camel"):
    """The IP's busiest hour, or UTC day on ranges over 7 days."""

    timestamp: Annotated[str, msgspec.Meta(description=f"The start of the hour or day, {IN_UTC}.")]
    hits: int


class ReportPathDTO(msgspec.Struct, rename="camel"):
    """A path the IP requested."""

    url: str
    hits: int
    error_hits: Annotated[int, msgspec.Meta(description="Requests that got a status of 400 or more.")]


class ReportUserAgentDTO(msgspec.Struct, rename="camel"):
    """A user agent the IP sent, with how often."""

    user_agent: str
    hits: int


class ReportLineDTO(msgspec.Struct, rename="camel"):
    """One access log line, without the Host header, server name, referrer or remote user."""

    timestamp: Annotated[str, msgspec.Meta(description=f"The request time, {IN_UTC}.")]
    method: str | None
    url: str | None
    http_version: str | None
    status_code: int | None
    bytes_sent: int | None
    user_agent: str | None


class ReportDecisionDTO(msgspec.Struct, rename="camel"):
    """An active CrowdSec decision on the IP, or on a range that holds it."""

    type: str
    scope: str
    value: str
    origin: str
    scenario: Annotated[
        str,
        msgspec.Meta(
            description="The scenario that made the decision, or `manual` for a decision a person made."
        ),
    ]
    duration: CrowdSecDuration


class ReportAlertDecisionDTO(msgspec.Struct, rename="camel"):
    """A decision an alert made, still in force or expired."""

    type: str
    duration: CrowdSecDuration
    expired: bool


class ReportAlertDTO(msgspec.Struct, rename="camel"):
    """A CrowdSec alert on the IP whose activity overlaps the range."""

    scenario: Annotated[
        str, msgspec.Meta(description="The scenario that fired, or `manual` for an alert a person made.")
    ]
    kind: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "Where the alert came from, such as `crowdsec` or `waf`. Null from a LAPI that predates the field."
            )
        ),
    ]
    created_at: Annotated[str, msgspec.Meta(description="When the LAPI stored the alert, as RFC 3339.")]
    start_at: Annotated[str | None, msgspec.Meta(description="When the first event happened.")]
    stop_at: Annotated[str | None, msgspec.Meta(description="When the last event happened.")]
    events_count: int
    decisions: list[ReportAlertDecisionDTO]


class ReportDropNetworkDTO(msgspec.Struct, rename="camel"):
    """The Spamhaus DROP network that holds the IP."""

    cidr: str
    sbl_id: Annotated[str, msgspec.Meta(description="The Spamhaus SBL record id of the listing, such as `SBL123456`.")]


class ReportIpDTO(msgspec.Struct, rename="camel"):
    """What the report says about one source IP."""

    ip_address: str
    country_code: str | None
    country_name: str | None
    asn: Annotated[
        int | None, msgspec.Meta(description="The ASN from the IP's newest line with ASN data.")
    ]
    asn_organization: str | None
    total_requests: int
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    total_bytes: Annotated[int, msgspec.Meta(description="The response bytes the server sent the IP.")]
    first_seen: Annotated[str | None, msgspec.Meta(description=f"The first request in the range, {IN_UTC}.")]
    last_seen: Annotated[str | None, msgspec.Meta(description=f"The last request in the range, {IN_UTC}.")]
    distinct_paths: Annotated[int, msgspec.Meta(description="Distinct URLs the IP requested.")]
    malformed_requests: Annotated[
        int,
        msgspec.Meta(
            description=(
                "Malformed lines from the IP that GeoMetrikks stored in the range. These go back "
                "ANALYTICS_DEBUG_RETENTION_DAYS days, 30 by default."
            )
        ),
    ]
    peak: Annotated[ReportPeakDTO | None, msgspec.Meta(description="Null when the IP sent no requests.")]
    paths: Annotated[list[ReportPathDTO], msgspec.Meta(description="The ten most requested paths, the most first.")]
    user_agents: Annotated[
        list[ReportUserAgentDTO], msgspec.Meta(description="The three most sent user agents, the most first.")
    ]
    lines: Annotated[
        list[ReportLineDTO],
        msgspec.Meta(description="The newest `linesPerIp` lines, oldest first."),
    ]
    decisions: Annotated[
        list[ReportDecisionDTO],
        msgspec.Meta(
            description=(
                "The decisions active now, whatever the range. Empty when `crowdsec.status` is `disabled` or "
                "`unavailable`."
            )
        ),
    ]
    alerts: Annotated[
        list[ReportAlertDTO],
        msgspec.Meta(description="Oldest first. Empty unless `crowdsec.status` is `ok`."),
    ]
    alerts_truncated: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "True when the LAPI hit the alert limit, 1000 for an IP report and 100 per IP for an ASN report, "
                "so older alerts in the range are missing."
            )
        ),
    ]
    drop_network: Annotated[
        ReportDropNetworkDTO | None, msgspec.Meta(description="Null when no DROP network holds the IP.")
    ]
    asn_drop: Annotated[bool, msgspec.Meta(description="True when the IP's ASN is on the Spamhaus ASN-DROP list.")]


CrowdSecReportStatus = Literal["disabled", "ok", "decisions-only", "unavailable"]


class ReportCrowdSec(msgspec.Struct, rename="camel"):
    """How much CrowdSec data the report holds."""

    status: Annotated[
        CrowdSecReportStatus,
        msgspec.Meta(
            description=(
                "`ok` with decisions and alerts, `decisions-only` without machine credentials, `disabled` with "
                "the integration off, and `unavailable` when the LAPI did not answer. The access log evidence "
                "is there in every case."
            )
        ),
    ]
    message: Annotated[
        str | None, msgspec.Meta(description="Says what is missing and why. Null for `ok` and `disabled`.")
    ]


class AbuseReportResponse(msgspec.Struct, rename="camel"):
    """Evidence for an abuse report, with every time in UTC."""

    target: ReportTarget
    start_date: Annotated[str, msgspec.Meta(description="The request's `startDate`, echoed as ISO 8601.")]
    end_date: Annotated[str, msgspec.Meta(description="The request's `endDate`, echoed as ISO 8601.")]
    generated_at: Annotated[str, msgspec.Meta(description=f"When GeoMetrikks built the report, {IN_UTC}.")]
    granularity: Annotated[
        Literal["hourly", "daily"],
        msgspec.Meta(description="The bucket size of each `peak`. `hourly` for ranges up to 7 days, `daily` above."),
    ]
    ip_count: Annotated[
        int,
        msgspec.Meta(
            description=(
                "The IPs of the target that sent requests in the range, which can be more than `ips` holds. 0 or 1 "
                "for an IP report."
            )
        ),
    ]
    total_requests: Annotated[int, msgspec.Meta(description="Requests from every IP of the target in the range.")]
    status_4xx: Annotated[
        int, msgspec.Meta(description="Those requests that got a 4xx status.")
    ] = msgspec.field(name="status4xx")
    redactions: Annotated[
        int, msgspec.Meta(description="How many names, addresses and credential values became `[redacted]`.")
    ]
    crowdsec: ReportCrowdSec
    ips: Annotated[
        list[ReportIpDTO],
        msgspec.Meta(
            description=(
                "For an ASN report, its busiest IPs, at most `maxIps`. An IP report has one entry, with zero "
                "counts when the IP sent nothing."
            )
        ),
    ]


class AbuseContactResponse(msgspec.Struct, rename="camel"):
    """The network or AS record that holds an IP or AS number, with its abuse contact, from RDAP."""

    query: Annotated[str, msgspec.Meta(description="The IP as looked up, or the AS number as `AS13335`.")]
    kind: Literal["ip", "asn"]
    registry: Annotated[str, msgspec.Meta(description="The host name of the registry that answered.")]
    rdap_url: Annotated[str, msgspec.Meta(description="The RDAP URL that gave the record.")]
    name: Annotated[str | None, msgspec.Meta(description="The record's name, such as the network name.")]
    handle: Annotated[str | None, msgspec.Meta(description="The registry's handle for the record.")]
    start_address: Annotated[str | None, msgspec.Meta(description="The first address of the network.")]
    end_address: Annotated[str | None, msgspec.Meta(description="The last address of the network.")]
    cidrs: Annotated[
        list[str], msgspec.Meta(description="The prefixes that make up the network, when the registry lists them.")
    ]
    country: Annotated[str | None, msgspec.Meta(description="The country code the registry gives.")]
    abuse_emails: Annotated[
        list[str],
        msgspec.Meta(
            description="Addresses of the abuse contact. Empty when the registry lists none."
        ),
    ]
    abuse_name: Annotated[str | None, msgspec.Meta(description="The abuse contact's name.")]
