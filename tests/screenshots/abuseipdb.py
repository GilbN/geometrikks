"""AbuseIPDB fixtures: stored reports, the answers the capture browser gives, and the checks that nothing left.

The app runs without an AbuseIPDB key, so it builds no AbuseIPDB client, and
the check, the report and the blacklist download have nothing to send with.
The Reports tab reads stored reports from the database, so the fixture
reports go straight into it. Status, blacklist and check answers come from
the key and from AbuseIPDB, so the capture browser answers those itself.
Every address here is one of the AS64496 documentation visitors, never an
AS64497 home visitor, so no abuse wording sits next to the made-up broadband network.
"""

from __future__ import annotations

import ipaddress
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal

import asyncpg
import msgspec

from geometrikks.domain.abuseipdb.schemas import (
    AbuseIpdbBlacklistResponse,
    AbuseIpdbStatusResponse,
    CheckResponse,
    RateLimitDTO,
)
from tests.screenshots.doc_traffic import DOC_AS_NAME, DOC_INSPECT_IP, DOC_VISITORS


@dataclass(frozen=True, slots=True)
class FixtureReport:
    ip: str
    categories: tuple[int, ...]
    comment: str
    status: Literal["sent", "unconfirmed"]
    score: int | None
    reporter_kind: Literal["user", "api_key"]
    reporter_name: str
    age: timedelta
    """How long before the run the report went out."""


FIXTURE_REPORTS: Final[tuple[FixtureReport, ...]] = (
    FixtureReport(
        ip="203.0.113.23",
        categories=(19, 21),
        comment="41 HTTP requests, 39 answered 4xx. Probed /.env, /.git/config, /wp-login.php. CrowdSec: http-probing.",
        status="sent",
        score=64,
        reporter_kind="api_key",
        reporter_name="homepage-widget",
        age=timedelta(hours=5, minutes=12),
    ),
    FixtureReport(
        ip="2001:db8:d0c::5",
        categories=(21,),
        comment="18 HTTP requests, 18 answered 4xx. Probed /phpmyadmin/, /admin/config.php.",
        status="unconfirmed",
        score=None,
        reporter_kind="user",
        reporter_name="admin",
        age=timedelta(days=1, hours=3, minutes=40),
    ),
    FixtureReport(
        ip=DOC_INSPECT_IP,
        categories=(21,),
        comment="27 HTTP requests, 25 answered 4xx. Probed /.env, /server-status, /.aws/credentials.",
        status="sent",
        score=100,
        reporter_kind="user",
        reporter_name="admin",
        age=timedelta(days=3, hours=2, minutes=5),
    ),
    FixtureReport(
        ip="203.0.113.10",
        categories=(18, 21),
        comment="64 HTTP requests, 61 answered 4xx. Probed /wp-login.php, /xmlrpc.php. CrowdSec: http-wordpress-scan.",
        status="sent",
        score=37,
        reporter_kind="api_key",
        reporter_name="homepage-widget",
        age=timedelta(days=6, hours=7),
    ),
)
BLACKLISTED_IPS: Final[tuple[str, ...]] = (DOC_INSPECT_IP,)
REPORTS_PER_DAY: Final = 1000
CHECKS_PER_DAY: Final = 1000

INSERT_SQL: Final = """
INSERT INTO abuseipdb_reports (
    id, ip_address, categories, comment, attack_time, reported_at, status,
    abuse_confidence_score, reporter_kind, reporter_name, api_key_id
) VALUES ($1, $2::inet, $3::smallint[], $4, $5, $6, $7, $8, $9, $10, NULL)
"""

# The structlog events and errors the AbuseIPDB client, the report and the blacklist refresh log,
# the host they would contact, and the two app routes whose answers the browser gives itself.
OUTBOUND_LOG: Final = re.compile(
    r"abuseipdb_(check|report|blacklist)\w*|AbuseIPDB blacklist refresh|abuseipdb\.com"
    r"|/api/v1/abuseipdb/check|POST /api/v1/abuseipdb/reports",
    re.IGNORECASE,
)


_DOC_VISITOR_ADDRESSES: Final = frozenset(ipaddress.ip_address(ip) for ip in DOC_VISITORS)


def outside_doc_visitors(ips: Sequence[str]) -> list[str]:
    """The addresses that are not one of the AS64496 documentation visitors."""
    outside = []
    for ip in ips:
        try:
            known = ipaddress.ip_address(ip) in _DOC_VISITOR_ADDRESSES
        except ValueError:
            known = False
        if not known:
            outside.append(ip)
    return outside


async def write_fixture_reports(conn: asyncpg.Connection, *, now: datetime) -> int:
    outside = outside_doc_visitors([report.ip for report in FIXTURE_REPORTS])
    if outside:
        raise ValueError(f"AbuseIPDB fixture reports for addresses other than the AS64496 visitors: {', '.join(outside)}")
    await conn.executemany(
        INSERT_SQL,
        [
            (
                uuid.uuid4(),
                report.ip,
                list(report.categories),
                report.comment,
                now - report.age - timedelta(minutes=20),
                now - report.age,
                report.status,
                report.score,
                report.reporter_kind,
                report.reporter_name,
            )
            for report in FIXTURE_REPORTS
        ],
    )
    return len(FIXTURE_REPORTS)


async def stored_abuseipdb_problems(conn: asyncpg.Connection) -> list[str]:
    """A report for any address but the AS64496 visitors, or any blacklist row, which only a real download writes."""
    reported = [row["ip"] for row in await conn.fetch("SELECT host(ip_address) AS ip FROM abuseipdb_reports")]
    problems = [f"AbuseIPDB report for {ip}, not one of the AS64496 visitors" for ip in outside_doc_visitors(reported)]
    blacklisted = await conn.fetchval("SELECT count(*) FROM abuseipdb_blacklist")
    status_rows = await conn.fetchval("SELECT count(*) FROM abuseipdb_blacklist_status")
    if blacklisted or status_rows:
        problems.append(
            f"the AbuseIPDB blacklist tables hold {blacklisted} IPs and {status_rows} status rows, so the app downloaded"
        )
    return problems


def outbound_log_lines(log_text: str) -> list[str]:
    """App log lines that show an AbuseIPDB request, attempt or error."""
    return [line for line in log_text.splitlines() if OUTBOUND_LOG.search(line)]


def _next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def browser_answers(*, now: datetime) -> dict[str, object]:
    """What the capture browser answers for the endpoints that need a key or AbuseIPDB itself, in the app's wire shapes."""
    resets_at = _next_utc_midnight(now)
    status = AbuseIpdbStatusResponse(
        enabled=True,
        reporting_enabled=True,
        blacklist_enabled=True,
        reports=RateLimitDTO(limit=REPORTS_PER_DAY, remaining=REPORTS_PER_DAY - 4, resets_at=resets_at),
        checks=RateLimitDTO(limit=CHECKS_PER_DAY, remaining=CHECKS_PER_DAY - 23, resets_at=resets_at),
    )
    blacklist = AbuseIpdbBlacklistResponse(
        generated_at=now - timedelta(hours=3, minutes=10),
        refreshed_at=now - timedelta(hours=3),
        ips=list(BLACKLISTED_IPS),
    )
    checks = {
        DOC_INSPECT_IP: CheckResponse(
            ip_address=DOC_INSPECT_IP,
            abuse_confidence_score=100,
            total_reports=412,
            num_distinct_users=87,
            last_reported_at=now - timedelta(minutes=38),
            usage_type="Data Center/Web Hosting/Transit",
            isp=DOC_AS_NAME,
            domain="example.net",
            is_tor=False,
            is_whitelisted=False,
            country_code=None,
        )
    }
    answers = {
        "status": msgspec.to_builtins(status),
        "blacklist": msgspec.to_builtins(blacklist),
        "checks": {ip: msgspec.to_builtins(check) for ip, check in checks.items()},
    }
    outside = outside_doc_visitors([*BLACKLISTED_IPS, *checks])
    if outside:
        raise ValueError(f"AbuseIPDB browser answers for addresses other than the AS64496 visitors: {', '.join(outside)}")
    return answers
