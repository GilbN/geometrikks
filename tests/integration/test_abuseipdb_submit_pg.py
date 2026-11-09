"""submit_report against Postgres: the row is committed before the call and settled after it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx2
import pytest
import structlog
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from geometrikks.domain.abuseipdb.errors import (
    RecentReportError,
    ReportUnconfirmedError,
    UpstreamFailedError,
    UpstreamRateLimitedError,
    UpstreamRejectedError,
)
from geometrikks.domain.abuseipdb.models import AbuseIpdbReport
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbReportRepository
from geometrikks.domain.abuseipdb.service import Reporter, ReportSubmission, submit_report
from geometrikks.services.abuseipdb import AbuseIpdbClient

pytestmark = pytest.mark.anyio

API_KEY = "test-key-5f2c9a"
COMMENT = "Distinctive comment 7c41 about ssh brute force"
REPORTER = Reporter("user", "gilbn", None)
ACCEPTED = {"data": {"ipAddress": "3.5.140.2", "abuseConfidenceScore": 52}}


def client_for(answer, calls: list[httpx2.Request] | None = None) -> AbuseIpdbClient:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        if calls is not None:
            calls.append(request)
        if isinstance(answer, type) and issubclass(answer, Exception):
            raise answer("simulated", request=request)
        if callable(answer):
            return await answer(request)
        return answer

    return AbuseIpdbClient(api_key=API_KEY, timeout=5, transport=httpx2.MockTransport(handler))


def submission(ip_address: str = "3.5.140.2", now: datetime | None = None) -> ReportSubmission:
    attack_time = (now or datetime.now(UTC)) - timedelta(minutes=5)
    return ReportSubmission(ip_address=ip_address, categories=[18, 22], comment=COMMENT, attack_time=attack_time)


async def submit(
    session, client: AbuseIpdbClient, *, report: ReportSubmission | None = None, now: datetime | None = None
):
    now = now or datetime.now(UTC)
    return await submit_report(
        report or submission(now=now),
        reporter=REPORTER,
        repository=AbuseIpdbReportRepository(session=session, wrap_exceptions=False),
        client=client,
        reporting_enabled=True,
        now=now,
    )


async def stored_rows(pg_session_maker) -> list[AbuseIpdbReport]:
    async with pg_session_maker() as session:
        return list((await session.execute(select(AbuseIpdbReport))).scalars())


async def store(pg_session_maker, ip_address: str, reported_at: datetime, status: str = "sent") -> None:
    async with pg_session_maker() as session:
        session.add(
            AbuseIpdbReport(
                ip_address=ip_address,
                categories=[18],
                comment="earlier report",
                attack_time=reported_at,
                reported_at=reported_at,
                status=status,
                reporter_kind="user",
                reporter_name="gilbn",
            )
        )
        await session.commit()


async def test_accepted_report_is_stored_as_sent(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    async with pg_session_maker() as session:
        row = await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)), now=now)

    assert (row.status, row.abuse_confidence_score, row.reporter_kind) == ("sent", 52, "user")
    assert (row.ip_address, row.reporter_name, row.reported_at) == ("3.5.140.2", "gilbn", now)
    [stored] = await stored_rows(pg_session_maker)
    assert (stored.id, stored.status, stored.abuse_confidence_score) == (row.id, "sent", 52)
    assert (stored.categories, stored.comment) == ([18, 22], COMMENT)


async def test_row_is_committed_before_the_call(pg_session_maker, clean_abuseipdb_reports):
    seen_during_call: list[tuple[str, str]] = []

    async def answer(request: httpx2.Request) -> httpx2.Response:
        seen_during_call.extend((str(row.ip_address), row.status) for row in await stored_rows(pg_session_maker))
        return httpx2.Response(200, json=ACCEPTED)

    async with pg_session_maker() as session:
        await submit(session, client_for(answer))

    assert seen_during_call == [("3.5.140.2", "unconfirmed")]


async def test_second_report_inside_15_minutes_is_refused_without_a_call(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await store(pg_session_maker, "3.5.140.2", now - timedelta(minutes=10))
    calls: list[httpx2.Request] = []

    async with pg_session_maker() as session:
        with pytest.raises(RecentReportError) as refusal:
            await submit(session, client_for(httpx2.Response(200, json=ACCEPTED), calls), now=now)

    assert refusal.value.status_code == 429
    assert refusal.value.code == "abuseipdb_recent_report"
    assert refusal.value.detail == "Reported less than 15 minutes ago"
    assert refusal.value.headers == {"Retry-After": "300"}
    assert calls == []
    assert len(await stored_rows(pg_session_maker)) == 1


async def test_retry_after_rounds_up(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await store(pg_session_maker, "3.5.140.2", now - timedelta(minutes=10, milliseconds=500))

    async with pg_session_maker() as session:
        with pytest.raises(RecentReportError) as refusal:
            await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)), now=now)

    assert refusal.value.headers == {"Retry-After": "300"}


async def test_a_report_15_minutes_old_no_longer_blocks(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await store(pg_session_maker, "3.5.140.2", now - timedelta(minutes=15))

    async with pg_session_maker() as session:
        row = await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)), now=now)

    assert row.status == "sent"


async def test_unconfirmed_rows_count_for_the_window(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await store(pg_session_maker, "3.5.140.2", now - timedelta(minutes=5), status="unconfirmed")
    calls: list[httpx2.Request] = []

    async with pg_session_maker() as session:
        with pytest.raises(RecentReportError) as refusal:
            await submit(session, client_for(httpx2.Response(200, json=ACCEPTED), calls), now=now)

    assert refusal.value.headers == {"Retry-After": "600"}
    assert calls == []


async def test_window_matches_other_ipv6_spellings(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await store(pg_session_maker, "2600:1f18::1", now - timedelta(minutes=1))
    calls: list[httpx2.Request] = []

    async with pg_session_maker() as session:
        with pytest.raises(RecentReportError):
            await submit(
                session,
                client_for(httpx2.Response(200, json=ACCEPTED), calls),
                report=submission("2600:1F18:0:0::1", now),
                now=now,
            )

    assert calls == []


async def test_reports_send_the_normalized_ip(pg_session_maker, clean_abuseipdb_reports):
    calls: list[httpx2.Request] = []

    async with pg_session_maker() as session:
        row = await submit(
            session, client_for(httpx2.Response(200, json=ACCEPTED), calls), report=submission(" 2600:1F18:0:0::1 ")
        )

    assert row.ip_address == "2600:1f18::1"
    assert b"ip=2600%3A1f18%3A%3A1" in calls[0].content


def _errors(detail: str) -> dict:
    return {"errors": [{"detail": detail, "status": 0}]}


@pytest.mark.parametrize(
    ("answer", "error", "status", "code", "detail", "headers"),
    [
        (
            httpx2.Response(
                429,
                headers={"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "996", "X-RateLimit-Reset": "1762560000"},
                json=_errors("You can only report the same IP address once in 15 minutes."),
            ),
            UpstreamRateLimitedError, 429, "abuseipdb_rate_limited",
            "You can only report the same IP address once in 15 minutes.", None,
        ),
        (
            httpx2.Response(
                429,
                headers={
                    "Retry-After": "3600",
                    "X-RateLimit-Limit": "1000",
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": "1762560000",
                },
                json=_errors("Daily rate limit of 1000 requests exceeded."),
            ),
            UpstreamRateLimitedError, 429, "abuseipdb_rate_limited",
            "AbuseIPDB's daily report limit is used up. It resets at 00:00 UTC.", {"Retry-After": "3600"},
        ),
        (
            httpx2.Response(429, json=_errors("Too many requests.")),
            UpstreamRateLimitedError, 429, "abuseipdb_rate_limited", "Too many requests.", None,
        ),
        (
            httpx2.Response(422, json=_errors("The comment field must not be greater than 1024 characters.")),
            UpstreamRejectedError, 400, "abuseipdb_rejected",
            "The comment field must not be greater than 1024 characters.", None,
        ),
        (
            httpx2.Response(401, json=_errors(f"Authentication failed for {API_KEY}.")),
            UpstreamFailedError, 502, "abuseipdb_failed", "AbuseIPDB rejected ABUSEIPDB_API_KEY", None,
        ),
        (
            httpx2.Response(404, json=_errors("Not found.")),
            UpstreamFailedError, 502, "abuseipdb_failed", "Not found.", None,
        ),
        (
            httpx2.ConnectError,
            UpstreamFailedError, 502, "abuseipdb_failed", "Could not reach AbuseIPDB (ConnectError)", None,
        ),
    ],
    ids=["429", "daily-429", "429-no-retry-after", "422", "401", "404", "connect-error"],
)
async def test_clear_rejections_delete_the_row(
    pg_session_maker, clean_abuseipdb_reports, answer, error, status, code, detail, headers
):
    with structlog.testing.capture_logs() as logs:
        async with pg_session_maker() as session:
            with pytest.raises(error) as refusal:
                await submit(session, client_for(answer))

    assert (refusal.value.status_code, refusal.value.code, refusal.value.detail) == (status, code, detail)
    assert refusal.value.headers == headers
    assert await stored_rows(pg_session_maker) == []
    [failed] = [log for log in logs if log["event"] == "abuseipdb_report_failed"]
    assert failed["ip_address"] == "3.5.140.2"


@pytest.mark.parametrize(
    "answer",
    [httpx2.ReadTimeout, httpx2.Response(503, text="Service Unavailable"), httpx2.Response(200, text="<html>")],
    ids=["read-timeout", "503", "200-html"],
)
async def test_uncertain_outcomes_keep_the_row_unconfirmed(pg_session_maker, clean_abuseipdb_reports, answer):
    async with pg_session_maker() as session:
        with pytest.raises(ReportUnconfirmedError) as refusal:
            await submit(session, client_for(answer))

    assert (refusal.value.status_code, refusal.value.code) == (502, "abuseipdb_unconfirmed")
    assert refusal.value.detail == (
        "AbuseIPDB did not confirm the report. It may have been sent, and GeoMetrikks recorded it as unconfirmed."
    )
    [stored] = await stored_rows(pg_session_maker)
    assert (str(stored.ip_address), stored.status, stored.abuse_confidence_score) == ("3.5.140.2", "unconfirmed", None)


async def test_failed_update_after_acceptance_stays_unconfirmed(pg_session_maker, clean_abuseipdb_reports, monkeypatch):
    async def failing_update(*args, **kwargs):
        raise SQLAlchemyError("simulated update failure")

    monkeypatch.setattr(AbuseIpdbReportRepository, "update", failing_update)

    with structlog.testing.capture_logs() as logs:
        async with pg_session_maker() as session:
            with pytest.raises(ReportUnconfirmedError):
                await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)))

    [stored] = await stored_rows(pg_session_maker)
    assert (stored.status, stored.abuse_confidence_score) == ("unconfirmed", None)
    [failed] = [log for log in logs if log["event"] == "abuseipdb_report_failed"]
    assert (failed["reason"], failed["upstream_status"], failed["error_type"]) == (
        "settle_failed", None, "SQLAlchemyError"
    )
    assert not [log for log in logs if log["event"] == "abuseipdb_report_sent"]


async def test_a_failed_settle_commit_stays_unconfirmed(pg_session_maker, clean_abuseipdb_reports, monkeypatch):
    async with pg_session_maker() as session:
        real_commit = session.commit
        commits = 0

        async def commit_that_fails_on_the_settle():
            nonlocal commits
            commits += 1
            if commits == 2:
                raise SQLAlchemyError("simulated commit failure")
            await real_commit()

        monkeypatch.setattr(session, "commit", commit_that_fails_on_the_settle)
        with pytest.raises(ReportUnconfirmedError):
            await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)))

        assert commits == 2
        assert (await session.execute(text("SELECT 1"))).scalar_one() == 1

    [stored] = await stored_rows(pg_session_maker)
    assert (stored.status, stored.abuse_confidence_score) == ("unconfirmed", None)


async def test_no_refresh_runs_after_the_settle_commit(pg_session_maker, clean_abuseipdb_reports, monkeypatch):
    now = datetime.now(UTC)
    async with pg_session_maker() as session:
        real_refresh = session.refresh
        report_sent = False

        async def accept(request: httpx2.Request) -> httpx2.Response:
            nonlocal report_sent
            report_sent = True
            return httpx2.Response(200, json=ACCEPTED)

        async def refresh_that_fails_after_the_call(*args, **kwargs):
            if report_sent:
                raise SQLAlchemyError("simulated refresh failure")
            await real_refresh(*args, **kwargs)

        monkeypatch.setattr(session, "refresh", refresh_that_fails_after_the_call)
        row = await submit(session, client_for(accept), now=now)

    assert (row.status, row.abuse_confidence_score, row.reported_at, row.ip_address) == ("sent", 52, now, "3.5.140.2")
    [stored] = await stored_rows(pg_session_maker)
    assert (stored.status, stored.abuse_confidence_score) == ("sent", 52)


async def test_no_refresh_runs_after_the_insert_commit(pg_session_maker, clean_abuseipdb_reports, monkeypatch):
    calls: list[httpx2.Request] = []

    async def refresh_that_always_fails(*args, **kwargs):
        raise SQLAlchemyError("simulated refresh failure")

    async with pg_session_maker() as session:
        monkeypatch.setattr(session, "refresh", refresh_that_always_fails)
        row = await submit(session, client_for(httpx2.Response(200, json=ACCEPTED), calls))

    assert len(calls) == 1
    assert (row.status, row.ip_address) == ("sent", "3.5.140.2")
    [stored] = await stored_rows(pg_session_maker)
    assert stored.status == "sent"


async def test_a_failed_cleanup_still_raises_the_upstream_refusal(
    pg_session_maker, clean_abuseipdb_reports, monkeypatch
):
    async def delete_that_aborts_the_transaction(self, *args, **kwargs):
        await self.session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(AbuseIpdbReportRepository, "delete", delete_that_aborts_the_transaction)
    refusal_detail = "The comment field must not be greater than 1024 characters."

    with structlog.testing.capture_logs() as logs:
        async with pg_session_maker() as session:
            with pytest.raises(UpstreamRejectedError) as refusal:
                await submit(session, client_for(httpx2.Response(422, json=_errors(refusal_detail))))
            assert (await session.execute(text("SELECT 1"))).scalar_one() == 1

    assert (refusal.value.status_code, refusal.value.detail) == (400, refusal_detail)
    [failed] = [log for log in logs if log["event"] == "abuseipdb_report_failed"]
    assert failed == {
        "event": "abuseipdb_report_failed",
        "log_level": "warning",
        "ip_address": "3.5.140.2",
        "upstream_status": 422,
        "reason": "cleanup_failed",
        "error_type": "DBAPIError",
    }
    [stored] = await stored_rows(pg_session_maker)
    assert stored.status == "unconfirmed"


async def test_logs_never_carry_the_comment(pg_session_maker, clean_abuseipdb_reports):
    with structlog.testing.capture_logs() as logs:
        async with pg_session_maker() as session:
            await submit(session, client_for(httpx2.Response(200, json=ACCEPTED)))
            with pytest.raises(UpstreamFailedError):
                await submit(
                    session,
                    client_for(httpx2.Response(401, json=_errors(f"Bad key {API_KEY}"))),
                    report=submission("8.8.8.8"),
                )
            with pytest.raises(ReportUnconfirmedError):
                await submit(session, client_for(httpx2.ReadTimeout), report=submission("1.1.1.1"))

    [sent] = [log for log in logs if log["event"] == "abuseipdb_report_sent"]
    assert sent == {
        "event": "abuseipdb_report_sent",
        "log_level": "info",
        "ip_address": "3.5.140.2",
        "categories": [18, 22],
        "score": 52,
        "reporter_kind": "user",
        "comment_length": len(COMMENT),
    }
    assert len([log for log in logs if log["event"] == "abuseipdb_report_failed"]) == 2
    for log in logs:
        assert COMMENT not in repr(log) and API_KEY not in repr(log)
