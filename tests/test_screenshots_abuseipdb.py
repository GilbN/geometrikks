"""AbuseIPDB fixtures for the screenshot run: stored reports, the browser's answers and the outbound checks."""

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import msgspec

from geometrikks.domain.abuseipdb.schemas import (
    AbuseIpdbBlacklistResponse,
    AbuseIpdbStatusResponse,
    CheckResponse,
)
from tests.screenshots.abuseipdb import (
    BLACKLISTED_IPS,
    FIXTURE_REPORTS,
    browser_answers,
    outbound_log_lines,
    outside_doc_visitors,
    stored_abuseipdb_problems,
)
from tests.screenshots.doc_traffic import DOC_INSPECT_IP

NOW = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)


def test_fixture_reports_use_documentation_visitors_and_made_up_senders() -> None:
    assert outside_doc_visitors([report.ip for report in FIXTURE_REPORTS]) == []
    assert {report.reporter_name for report in FIXTURE_REPORTS} == {"admin", "homepage-widget"}
    assert {report.reporter_kind for report in FIXTURE_REPORTS} == {"user", "api_key"}
    assert [report.status for report in FIXTURE_REPORTS].count("unconfirmed") == 1
    assert all((report.score is None) == (report.status == "unconfirmed") for report in FIXTURE_REPORTS)
    assert all(set(report.categories) <= set(range(1, 24)) for report in FIXTURE_REPORTS)
    assert all(len(report.comment) <= 1024 for report in FIXTURE_REPORTS)


def test_the_inspected_ip_has_an_earlier_report_outside_the_15_minute_window() -> None:
    inspected = [report for report in FIXTURE_REPORTS if report.ip == DOC_INSPECT_IP]
    assert inspected and all(report.age.total_seconds() > 15 * 60 for report in inspected)


def test_browser_answers_decode_as_the_app_s_own_responses() -> None:
    answers = browser_answers(now=NOW)
    status = msgspec.convert(answers["status"], AbuseIpdbStatusResponse)
    assert status.enabled and status.reporting_enabled and status.blacklist_enabled
    blacklist = msgspec.convert(answers["blacklist"], AbuseIpdbBlacklistResponse)
    assert blacklist.ips == list(BLACKLISTED_IPS) == [DOC_INSPECT_IP]
    # The app stops showing a list more than 72 hours old.
    assert blacklist.refreshed_at is not None and NOW - blacklist.refreshed_at < timedelta(hours=72)
    checks = answers["checks"]
    assert isinstance(checks, dict) and set(checks) == {DOC_INSPECT_IP}
    check = msgspec.convert(checks[DOC_INSPECT_IP], CheckResponse)
    assert check.abuse_confidence_score == 100 and check.ip_address == DOC_INSPECT_IP
    assert set(checks[DOC_INSPECT_IP]) >= {"abuseConfidenceScore", "totalReports", "numDistinctUsers", "isTor"}


def test_outside_doc_visitors_names_every_other_address() -> None:
    assert outside_doc_visitors(["198.51.100.14", "2001:DB8:D0C:0::5", "10.1.2.3", "fd00::1", "nope"]) == [
        "10.1.2.3",
        "fd00::1",
        "nope",
    ]


def test_outside_doc_visitors_refuses_the_as64497_home_visitors() -> None:
    assert outside_doc_visitors(["192.0.2.131", "2001:db8:b0b:12::7", "203.0.113.99"]) == [
        "192.0.2.131",
        "2001:db8:b0b:12::7",
        "203.0.113.99",
    ]


def test_outbound_log_lines_catch_every_abuseipdb_request_and_error() -> None:
    lines = [
        "2026-11-12 info abuseipdb_check_fetched ip_address=198.51.100.14 score=100",
        "2026-11-12 info abuseipdb_check ip_address=198.51.100.14",
        "2026-11-12 info abuseipdb_report_upstream ip_address=198.51.100.14",
        "2026-11-12 warning abuseipdb_report_failed reason=unreachable",
        "2026-11-12 warning abuseipdb_blacklist_refresh_failed reason=Could not reach AbuseIPDB",
        "2026-11-12 info Scheduled AbuseIPDB blacklist refresh every 24 hour(s)",
        "HTTP Request: GET https://api.abuseipdb.com/api/v2/check",
        'INFO: 127.0.0.1:5000 - "GET /api/v1/abuseipdb/check?ipAddress=198.51.100.14 HTTP/1.1" 404',
        'INFO: 127.0.0.1:5000 - "POST /api/v1/abuseipdb/reports HTTP/1.1" 403',
    ]
    assert len(outbound_log_lines("\n".join(lines))) == len(lines)


def test_outbound_log_lines_pass_the_local_reads() -> None:
    lines = [
        'INFO: 127.0.0.1:5000 - "GET /api/v1/abuseipdb/reports/history?currentPage=1&pageSize=10 HTTP/1.1" 200',
        'INFO: 127.0.0.1:5000 - "GET /api/v1/abuseipdb/reported-ips HTTP/1.1" 200',
        "2026-11-12 info app_started",
    ]
    assert outbound_log_lines("\n".join(lines)) == []


def test_the_report_scene_opens_the_inspected_ip() -> None:
    scenes = (Path(__file__).parent / "screenshots" / "scenes.ts").read_text()
    match = re.search(r'export const REPORTED_IP = "([^"]+)"', scenes)
    assert match and match.group(1) == DOC_INSPECT_IP


class StoredRows:
    def __init__(self, reported: list[str], blacklisted: int = 0) -> None:
        self.reported = reported
        self.blacklisted = blacklisted

    async def fetch(self, sql: str) -> list[dict[str, str]]:
        return [{"ip": ip} for ip in self.reported]

    async def fetchval(self, sql: str) -> int:
        return self.blacklisted


def test_stored_reports_for_a_home_visitor_fail_the_run() -> None:
    conn = StoredRows(["198.51.100.14", "192.0.2.150"])
    problems = asyncio.run(stored_abuseipdb_problems(cast(Any, conn)))
    assert problems == ["AbuseIPDB report for 192.0.2.150, not one of the AS64496 visitors"]


def test_any_blacklist_row_fails_the_run() -> None:
    problems = asyncio.run(stored_abuseipdb_problems(cast(Any, StoredRows([], blacklisted=3))))
    assert len(problems) == 1 and "so the app downloaded" in problems[0]


def test_the_screenshot_build_anchor_still_opens_is_public_ip() -> None:
    root = Path(__file__).parents[1]
    config = (root / "tests" / "screenshots" / "vite.config.ts").read_text()
    match = re.search(r'export const PUBLIC_IP_ANCHOR =\s*("(?:[^"\\]|\\.)*")', config)
    assert match, "PUBLIC_IP_ANCHOR is no longer a plain string literal"
    assert json.loads(match.group(1)) in (root / "resources" / "lib" / "abuseipdb.ts").read_text()
