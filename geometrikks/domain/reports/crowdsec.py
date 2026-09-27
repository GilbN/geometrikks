"""CrowdSec decisions and detections for the IPs in an abuse report.

The LAPI has no batch lookup, so this asks once per IP, a few at a time.
If the LAPI fails, the report keeps its access-log evidence, which is the
part the abuse desk needs most.
"""
from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from geometrikks.domain.reports.schemas import CrowdSecReportStatus
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import Alert, CrowdSecError, CrowdSecService, Decision

logger = get_logger(__name__)

LAPI_CONCURRENCY = 4
# A busy scanner holds a few hundred alerts a week at ~6 KiB each, events
# included. One IP gets far more room than each IP of an ASN report.
IP_ALERT_LIMIT = 1000
ASN_ALERT_LIMIT = 100


@dataclass
class IpCrowdSec:
    decisions: list[Decision] = field(default_factory=list)
    alerts: list[Alert] = field(default_factory=list)
    # The LAPI hit the alert limit, so older alerts in the window are missing.
    alerts_truncated: bool = False


@dataclass
class CrowdSecEvidence:
    status: CrowdSecReportStatus
    message: str | None = None
    by_ip: dict[str, IpCrowdSec] = field(default_factory=dict)


def _since(start: datetime, now: datetime) -> str | None:
    """The window start as the LAPI's ``since`` lookback, whole hours rounded up."""
    hours = math.ceil((now - start).total_seconds() / 3600)
    return f"{hours}h" if hours > 0 else None


def _until(end: datetime, now: datetime) -> str | None:
    """The window end as the LAPI's ``until`` lookback, whole hours rounded
    down so the last partial hour stays in. Without it, alerts newer than an
    old window would use up the limit before the window filter runs."""
    hours = math.floor((now - end).total_seconds() / 3600)
    return f"{hours}h" if hours > 0 else None


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def alert_in_window(alert: Alert, start: datetime, end: datetime) -> bool:
    """Whether the alert's activity overlaps the window. An alert whose
    times do not parse stays in, because dropping evidence is the worse
    mistake."""
    first = _parse(alert.start_at) or _parse(alert.created_at)
    last = _parse(alert.stop_at) or _parse(alert.created_at)
    if first is None or last is None:
        return True
    return first < end and last >= start


async def gather_crowdsec(
    service: CrowdSecService | None,
    ips: list[str],
    start: datetime,
    end: datetime,
    *,
    alerts_enabled: bool,
    alert_limit: int = IP_ALERT_LIMIT,
    now: datetime | None = None,
) -> CrowdSecEvidence:
    """Active decisions for every IP, plus its alerts when machine credentials
    exist; ``alert_limit`` caps the newest alerts fetched per IP."""
    if service is None:
        return CrowdSecEvidence(status="disabled")
    now = now or datetime.now(timezone.utc)
    since, until = _since(start, now), _until(end, now)
    limiter = asyncio.Semaphore(LAPI_CONCURRENCY)

    async def one(ip: str) -> tuple[str, IpCrowdSec]:
        async with limiter:
            decisions = await service.get_decisions_for_ip(ip)
            alerts: list[Alert] = []
            if alerts_enabled:
                alerts = await service.get_alerts(limit=alert_limit, ip=ip, since=since, until=until)
        return ip, IpCrowdSec(
            decisions=decisions,
            alerts=sorted(
                (a for a in alerts if alert_in_window(a, start, end)),
                # Sorted by parsed time, because LAPI times carry nanoseconds.
                key=lambda a: _parse(a.start_at) or _parse(a.created_at) or datetime.min.replace(tzinfo=timezone.utc),
            ),
            alerts_truncated=len(alerts) >= alert_limit,
        )

    failure: str | None = None
    try:
        # A TaskGroup cancels the remaining lookups on the first failure.
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(one(ip)) for ip in ips]
    except* CrowdSecError as errors:
        failure = str(errors.exceptions[0])
    if failure is not None:
        logger.warning("abuse_report_crowdsec_failed", error=failure, ips=len(ips))
        return CrowdSecEvidence(
            status="unavailable",
            message="The report has no CrowdSec data because the LAPI did not answer.",
        )
    results = [task.result() for task in tasks]
    return CrowdSecEvidence(
        status="ok" if alerts_enabled else "decisions-only",
        message=None if alerts_enabled else (
            "The report lists active decisions only. Detections need "
            "CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD."
        ),
        by_ip=dict(results),
    )
