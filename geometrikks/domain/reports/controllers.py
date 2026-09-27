"""Abuse report endpoints: the evidence, and the RDAP abuse contact."""
from __future__ import annotations

import ipaddress
import re
from datetime import datetime, timezone
from typing import Annotated

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import QueryParameter, SkipValidation
from litestar.status_codes import HTTP_400_BAD_REQUEST, HTTP_404_NOT_FOUND, HTTP_502_BAD_GATEWAY

from geometrikks.config.settings import Settings
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.domain.reports.abuse_report import AbuseReportRepository, ReportIp
from geometrikks.domain.reports.crowdsec import (
    ASN_ALERT_LIMIT,
    IP_ALERT_LIMIT,
    IpCrowdSec,
    gather_crowdsec,
)
from geometrikks.domain.reports.dependencies import provide_abuse_report_repo, provide_rdap_client
from geometrikks.domain.reports.schemas import (
    AbuseContactResponse,
    AbuseReportResponse,
    ReportAlertDecisionDTO,
    ReportAlertDTO,
    ReportCrowdSec,
    ReportDecisionDTO,
    ReportIpDTO,
    ReportLineDTO,
    ReportPathDTO,
    ReportPeakDTO,
    ReportTarget,
    ReportUserAgentDTO,
)
from geometrikks.domain.security.dependencies import provide_crowdsec_service
from geometrikks.lib.parameters import EndDate, StartDate
from geometrikks.server.exceptions import ErrorEnvelope
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import Alert, CrowdSecService, Decision
from geometrikks.services.rdap import AbuseContact, RdapClient

logger = get_logger(__name__)

MAX_ASN = 4_294_967_295

IpAddressParam = Annotated[
    str | None,
    QueryParameter(name="ipAddress", required=False, description="The IP to report on"),
]
AsnParam = Annotated[
    int | None,
    QueryParameter(required=False, ge=0, le=MAX_ASN, description="The AS number whose IPs to report on"),
]


def _canonical_ip(value: str) -> str:
    """The form Postgres ``host()`` prints, so result rows match the request."""
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as exc:
        raise DomainValidationError(f"Invalid IP address: {value!r}") from exc


def _one_target(ip_address: str | None, asn: int | None) -> None:
    if (ip_address is None) == (asn is None):
        raise DomainValidationError("Pass exactly one of ipAddress or asn")


# Only these carry a detection's scenario name. Every other origin (cscli,
# cscli-import, console, geometrikks) is a person's decision whose scenario
# holds their reason or machine name, so it reports as "manual".
DETECTION_ORIGINS = frozenset({"crowdsec", "CAPI", "lists", "appsec"})
DETECTION_KINDS = frozenset({"crowdsec", "waf", "bot-detection", "capi", "papi"})
MANUAL_SCENARIO = "manual"
# A hub or local scenario name: author/name, no spaces.
_SCENARIO_NAME = re.compile(r"[\w.-]+/[\w.-]+")


def _decision_scenario(decision: Decision) -> str:
    return decision.scenario if decision.origin in DETECTION_ORIGINS else MANUAL_SCENARIO


def _alert_scenario(alert: Alert) -> str:
    """The alert's scenario, or "manual" for an alert a person made. LAPIs
    before 1.7 send no kind, so a name then passes only if it looks like a
    scenario and is not our own manual one."""
    if alert.kind is not None:
        detected = alert.kind in DETECTION_KINDS
    else:
        detected = (
            _SCENARIO_NAME.fullmatch(alert.scenario) is not None
            and not alert.scenario.startswith("geometrikks/")
        )
    return alert.scenario if detected else MANUAL_SCENARIO


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _to_ip_dto(item: ReportIp, crowdsec: IpCrowdSec | None) -> ReportIpDTO:
    crowdsec = crowdsec or IpCrowdSec()
    return ReportIpDTO(
        ip_address=item.ip,
        country_code=item.country_code,
        country_name=item.country_name,
        asn=item.asn,
        asn_organization=item.asn_organization,
        total_requests=item.total_requests,
        status_2xx=item.status_2xx,
        status_3xx=item.status_3xx,
        status_4xx=item.status_4xx,
        status_5xx=item.status_5xx,
        total_bytes=item.total_bytes,
        first_seen=_iso(item.first_seen),
        last_seen=_iso(item.last_seen),
        distinct_paths=item.distinct_paths,
        malformed_requests=item.malformed_requests,
        peak=ReportPeakDTO(timestamp=item.peak.timestamp.isoformat(), hits=item.peak.hits) if item.peak else None,
        paths=[ReportPathDTO(url=p.url, hits=p.hits, error_hits=p.error_hits) for p in item.paths],
        user_agents=[ReportUserAgentDTO(user_agent=u.user_agent, hits=u.hits) for u in item.user_agents],
        lines=[
            ReportLineDTO(
                timestamp=line.timestamp.isoformat(),
                method=line.method,
                url=line.url,
                http_version=line.http_version,
                status_code=line.status_code,
                bytes_sent=line.bytes_sent,
                user_agent=line.user_agent,
            )
            for line in item.lines
        ],
        decisions=[
            ReportDecisionDTO(
                type=d.type, scope=d.scope, value=d.value, origin=d.origin,
                scenario=_decision_scenario(d), duration=d.duration,
            )
            for d in crowdsec.decisions
        ],
        # Machine names and alert messages stay out because they describe the
        # operator's setup, not the source's behavior.
        alerts=[
            ReportAlertDTO(
                scenario=_alert_scenario(a),
                kind=a.kind,
                created_at=a.created_at,
                start_at=a.start_at,
                stop_at=a.stop_at,
                events_count=a.events_count,
                decisions=[
                    ReportAlertDecisionDTO(type=d.type, duration=d.duration, expired=d.expired)
                    for d in a.decisions
                ],
            )
            for a in crowdsec.alerts
        ],
        alerts_truncated=crowdsec.alerts_truncated,
    )


def _to_contact_response(contact: AbuseContact) -> AbuseContactResponse:
    return AbuseContactResponse(
        query=contact.query,
        kind=contact.kind,
        registry=contact.registry,
        rdap_url=contact.rdap_url,
        name=contact.name,
        handle=contact.handle,
        start_address=contact.start_address,
        end_address=contact.end_address,
        cidrs=contact.cidrs,
        country=contact.country,
        abuse_emails=contact.abuse_emails,
        abuse_name=contact.abuse_name,
    )


class ReportsController(Controller):
    """Abuse reports for a hosting provider's abuse desk."""

    path = "/reports"
    tags = ["Reports"]
    dependencies = {
        "abuse_report_repo": Provide(provide_abuse_report_repo),
        "crowdsec": Provide(provide_crowdsec_service, sync_to_thread=False),
        "rdap": Provide(provide_rdap_client, sync_to_thread=False),
    }

    @get(
        "/abuse",
        description="Evidence for an abuse report on one IP or the busiest IPs of an ASN (raw scan).",
        responses={
            HTTP_400_BAD_REQUEST: ResponseSpec(
                data_container=ErrorEnvelope, description="Neither or both of ipAddress and asn."
            ),
        },
    )
    async def get_abuse_report(
        self,
        abuse_report_repo: NamedDependency[AbuseReportRepository],
        crowdsec: NamedDependency[CrowdSecService | None],
        settings: NamedDependency[SkipValidation[Settings]],
        start_date: StartDate,
        end_date: EndDate,
        ip_address: IpAddressParam = None,
        asn: AsnParam = None,
        max_ips: Annotated[
            int,
            QueryParameter(name="maxIps", ge=1, le=100, description="Busiest IPs to include for an ASN"),
        ] = 25,
        lines_per_ip: Annotated[
            int,
            QueryParameter(name="linesPerIp", ge=0, le=500, description="Newest log lines per IP"),
        ] = 20,
    ) -> AbuseReportResponse:
        """Per-IP totals, behavior, paths, user agents, log lines and CrowdSec
        detections, all in UTC.

        Leaves out the operator's vhosts, instance names, referrers and
        CrowdSec machine names, and scrubs the operator's names and address
        from the paths and user agents that remain.
        """
        _one_target(ip_address, asn)
        selection = None
        if asn is not None:
            selection = await abuse_report_repo.select_asn_ips(asn, start_date, end_date, max_ips)
            ips = selection.ips
        else:
            ips = [_canonical_ip(ip_address or "")]

        evidence = await abuse_report_repo.get_evidence(
            ips, start_date, end_date, lines_per_ip=lines_per_ip
        )
        crowdsec_evidence = await gather_crowdsec(
            crowdsec, ips, start_date, end_date,
            alerts_enabled=settings.crowdsec.write_enabled,
            alert_limit=IP_ALERT_LIMIT if selection is None else ASN_ALERT_LIMIT,
        )

        if selection is None:
            only = evidence.ips[0]
            target = ReportTarget(
                kind="ip", ip_address=only.ip, asn=only.asn, asn_organization=only.asn_organization
            )
            ip_count = 1 if only.total_requests else 0
            total_requests = only.total_requests
            status_4xx = only.status_4xx
        else:
            target = ReportTarget(
                kind="asn", ip_address=None, asn=asn, asn_organization=selection.organization
            )
            ip_count = selection.ip_count
            total_requests = selection.total_requests
            status_4xx = selection.total_4xx

        logger.info(
            "abuse_report_built",
            target=target.kind,
            asn=target.asn,
            ips=len(ips),
            crowdsec=crowdsec_evidence.status,
            redactions=evidence.redactions,
        )
        return AbuseReportResponse(
            target=target,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            generated_at=datetime.now(timezone.utc).isoformat(),
            granularity=evidence.granularity,
            ip_count=ip_count,
            total_requests=total_requests,
            status_4xx=status_4xx,
            redactions=evidence.redactions,
            crowdsec=ReportCrowdSec(status=crowdsec_evidence.status, message=crowdsec_evidence.message),
            ips=[_to_ip_dto(item, crowdsec_evidence.by_ip.get(item.ip)) for item in evidence.ips],
        )

    @get(
        "/abuse-contact",
        description="RDAP lookup of the network or AS holding an address, with its abuse contact.",
        responses={
            HTTP_400_BAD_REQUEST: ResponseSpec(
                data_container=ErrorEnvelope,
                description="Neither or both of ipAddress and asn, or a private address.",
            ),
            HTTP_404_NOT_FOUND: ResponseSpec(
                data_container=ErrorEnvelope, description="No registry covers or holds the query."
            ),
            HTTP_502_BAD_GATEWAY: ResponseSpec(
                data_container=ErrorEnvelope, description="The registry or IANA could not be reached."
            ),
        },
    )
    async def get_abuse_contact(
        self,
        rdap: NamedDependency[SkipValidation[RdapClient]],
        ip_address: IpAddressParam = None,
        asn: AsnParam = None,
    ) -> AbuseContactResponse:
        """Sends only the queried address or AS number to IANA and the registry."""
        _one_target(ip_address, asn)
        if asn is not None:
            contact = await rdap.lookup_asn(asn)
        else:
            contact = await rdap.lookup_ip(ip_address or "")
        return _to_contact_response(contact)
