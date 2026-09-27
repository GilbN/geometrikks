"""AbuseReportRepository against real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.domain.reports.abuse_report import AbuseReportRepository

pytestmark = pytest.mark.anyio

# Wall-clock derived and hour-aligned; see test_repositories_pg.py.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
SCANNER = "203.0.113.7"
QUIET = "203.0.113.8"
OTHER_AS = "198.51.100.9"
ASN = 64500


async def _insert_log(
    session, *, ts, ip=SCANNER, url="/", host="blog.example.com", status=404,
    ua="Go-http-client/1.1", asn=ASN, org="Example Hosting", hostname="nostromo",
):
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, http_version, host, "
        "status_code, bytes_sent, user_agent, referrer, hostname, country_code, "
        "autonomous_system_number, autonomous_system_organization) "
        "VALUES (:ts, CAST(:ip AS inet), 'GET', :url, 'HTTP/1.1', :host, :status, 10, :ua, "
        "'https://blog.example.com/', :hostname, 'US', :asn, :org)"
    ), {
        "ts": ts, "ip": ip, "url": url, "host": host, "status": status, "ua": ua,
        "asn": asn, "org": org, "hostname": hostname,
    })


async def test_asn_selection_ranks_ips_and_counts_all_of_them(pg_session_maker, clean_tables):
    t = NOW - timedelta(hours=2)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_log(session, ts=t)
        await _insert_log(session, ts=t, ip=QUIET)
        await _insert_log(session, ts=t, ip=OTHER_AS, asn=64501)
        await session.commit()

    async with pg_session_maker() as session:
        selection = await AbuseReportRepository(session).select_asn_ips(
            ASN, NOW - timedelta(hours=6), NOW, limit=1
        )

    assert selection.ips == [SCANNER]
    assert (selection.ip_count, selection.total_requests) == (2, 4)
    assert selection.organization == "Example Hosting"


async def test_evidence_is_per_ip_and_scrubs_operator_names(pg_session_maker, clean_tables):
    t0 = NOW - timedelta(hours=3)
    t1 = NOW - timedelta(hours=2)
    async with pg_session_maker() as session:
        for _ in range(4):
            await _insert_log(session, ts=t0, url="/.env")
        await _insert_log(session, ts=t1, url="/proxy?u=http://www.example.com/admin",
                          host="www.example.com", ua="scan (+www.example.com)")
        # A proxy probe: the spoofed Host is the scanner's, not the operator's.
        await _insert_log(session, ts=t1 + timedelta(minutes=1), url="http://www.google.com/",
                          host="www.google.com")
        # Five clients hit the server by its bare address and never get an answer.
        for n in range(5):
            await _insert_log(session, ts=t1, ip=f"192.0.2.{n + 1}", host="195.0.194.210", asn=None)
        await _insert_log(session, ts=t1 + timedelta(minutes=2), url="/?h=195.0.194.210",
                          host="195.0.194.210")
        # Someone got an answer from blog.example.com: it is the operator's.
        await _insert_log(session, ts=t1, ip=QUIET, url="/", status=200)
        await session.commit()

    async with pg_session_maker() as session:
        evidence = await AbuseReportRepository(session).get_evidence(
            [SCANNER, QUIET, OTHER_AS], NOW - timedelta(hours=6), NOW, lines_per_ip=2
        )

    scanner, quiet, absent = evidence.ips
    assert [i.ip for i in evidence.ips] == [SCANNER, QUIET, OTHER_AS]
    assert (scanner.total_requests, scanner.status_4xx, scanner.distinct_paths) == (7, 7, 4)
    assert (scanner.first_seen, scanner.last_seen) == (t0, t1 + timedelta(minutes=2))
    assert (scanner.asn, scanner.country_code) == (ASN, "US")
    assert scanner.peak is not None and (scanner.peak.timestamp, scanner.peak.hits) == (t0, 4)
    assert sorted(p.url for p in scanner.paths) == [
        "/.env", "/?h=[redacted]", "/proxy?u=[redacted]", "http://www.google.com/",
    ]
    # The newest two lines, oldest first.
    assert [line.url for line in scanner.lines] == ["http://www.google.com/", "/?h=[redacted]"]
    agents = {u.user_agent for u in scanner.user_agents}
    assert agents == {"Go-http-client/1.1", "scan (+[redacted])"}
    assert quiet.total_requests == 1 and quiet.status_2xx == 1
    assert absent.total_requests == 0 and absent.lines == []
    # Every occurrence counts: two top paths, one user agent, one log line.
    assert evidence.redactions == 4


async def test_zero_lines_skips_the_excerpt(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await _insert_log(session, ts=NOW - timedelta(hours=1))
        await session.commit()

    async with pg_session_maker() as session:
        evidence = await AbuseReportRepository(session).get_evidence(
            [SCANNER], NOW - timedelta(hours=6), NOW, lines_per_ip=0
        )

    assert evidence.ips[0].total_requests == 1
    assert evidence.ips[0].lines == []


async def test_a_short_window_still_knows_the_operator_hosts(pg_session_maker, clean_tables):
    """The vhost was served two days ago, not inside the one-hour report."""
    async with pg_session_maker() as session:
        await _insert_log(session, ts=NOW - timedelta(days=2), ip=QUIET, host="shop.example.net", status=200)
        await _insert_log(session, ts=NOW - timedelta(minutes=30), url="/?next=https://shop.example.net/x",
                          host="shop.example.net")
        await session.commit()

    async with pg_session_maker() as session:
        evidence = await AbuseReportRepository(session).get_evidence(
            [SCANNER], NOW - timedelta(hours=1), NOW, lines_per_ip=1
        )

    assert evidence.ips[0].lines[0].url == "/?next=[redacted]"
