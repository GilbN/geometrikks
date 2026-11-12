"""AbuseIPDB fixtures for the screenshot run: stored reports, the browser's answers and the outbound checks."""

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

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
    documentation_only,
    outbound_log_lines,
)
from tests.screenshots.doc_traffic import DOC_INSPECT_IP, DOC_VISITORS, is_documentation

NOW = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)


def test_fixture_reports_use_documentation_visitors_and_made_up_senders() -> None:
    assert all(is_documentation(report.ip) and report.ip in DOC_VISITORS for report in FIXTURE_REPORTS)
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


def test_documentation_only_names_addresses_outside_documentation_space() -> None:
    assert documentation_only(["198.51.100.14", "2001:db8:d0c::5", "10.1.2.3", "fd00::1"]) == ["10.1.2.3", "fd00::1"]


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
