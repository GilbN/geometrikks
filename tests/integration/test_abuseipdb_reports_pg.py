"""abuseipdb_reports against Postgres: the migration matches the model, and the repository queries behave."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from geometrikks.domain.abuseipdb.models import AbuseIpdbReport
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbReportRepository, ReportedIp

pytestmark = pytest.mark.anyio


def _report(ip_address: str, reported_at: datetime, **overrides) -> AbuseIpdbReport:
    fields = {
        "ip_address": ip_address,
        "categories": [18, 21],
        "comment": "ssh brute force",
        "attack_time": reported_at,
        "reported_at": reported_at,
        "status": "sent",
        "abuse_confidence_score": 42,
        "reporter_kind": "user",
        "reporter_name": "admin",
    }
    fields.update(overrides)
    return AbuseIpdbReport(**fields)


async def _store(pg_session_maker, *reports: AbuseIpdbReport) -> None:
    async with pg_session_maker() as session:
        session.add_all(reports)
        await session.commit()


def _only_abuseipdb_reports(schema_object, name, type_, reflected, compare_to) -> bool:
    if type_ == "table":
        return name == "abuseipdb_reports"
    return schema_object.table.name == "abuseipdb_reports"


async def test_migrated_table_matches_the_model(pg_engine):
    async with pg_engine.connect() as connection:
        schema_diffs = await connection.run_sync(
            lambda sync_connection: compare_metadata(
                MigrationContext.configure(
                    sync_connection, opts={"compare_type": True, "include_object": _only_abuseipdb_reports}
                ),
                AbuseIpdbReport.metadata,
            )
        )

    assert schema_diffs == []


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        ({"status": "failed"}, "ck_abuseipdb_reports_status"),
        ({"reporter_kind": "robot"}, "ck_abuseipdb_reports_reporter_kind"),
    ],
)
async def test_status_and_reporter_kind_are_constrained(
    pg_session_maker, clean_abuseipdb_reports, overrides, constraint
):
    with pytest.raises(IntegrityError, match=constraint):
        await _store(pg_session_maker, _report("3.5.140.2", datetime.now(UTC), **overrides))


async def test_deleting_an_api_key_keeps_its_reports(pg_session_maker, clean_abuseipdb_reports, clean_api_keys):
    key_id = uuid4()
    async with pg_session_maker() as session:
        await session.execute(
            text(
                "INSERT INTO api_keys (id, name, scope, key_hash, display_prefix, created_by)"
                " VALUES (:id, 'homepage', 'read_write', :hash, 'gk_abcde', 'admin')"
            ),
            {"id": key_id, "hash": "a" * 64},
        )
        await session.commit()
    await _store(
        pg_session_maker,
        _report("3.5.140.2", datetime.now(UTC), reporter_kind="api_key", reporter_name="homepage", api_key_id=key_id),
    )

    async with pg_session_maker() as session:
        await session.execute(text("DELETE FROM api_keys WHERE id = :id"), {"id": key_id})
        await session.commit()
    async with pg_session_maker() as session:
        row = (await session.execute(text("SELECT api_key_id, reporter_name FROM abuseipdb_reports"))).one()

    assert row.api_key_id is None and row.reporter_name == "homepage"


async def test_list_for_ip_is_newest_first_and_returns_strings(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    times = [now - timedelta(hours=5), now - timedelta(hours=1), now - timedelta(hours=3)]
    await _store(
        pg_session_maker,
        *[_report("3.5.140.2", reported_at) for reported_at in times],
        _report("8.8.8.8", now),
    )

    async with pg_session_maker() as session:
        rows = await AbuseIpdbReportRepository(session=session, wrap_exceptions=False).list_for_ip("3.5.140.2")

    assert [row.reported_at for row in rows] == sorted(times, reverse=True)
    assert all(isinstance(row.ip_address, str) for row in rows)
    assert {row.ip_address for row in rows} == {"3.5.140.2"}


async def test_latest_reported_at_matches_any_spelling_of_an_ipv6_address(pg_session_maker, clean_abuseipdb_reports):
    stored_time = datetime.now(UTC) - timedelta(minutes=3)
    await _store(pg_session_maker, _report("2600:1f18::1", stored_time))

    async with pg_session_maker() as session:
        repository = AbuseIpdbReportRepository(session=session, wrap_exceptions=False)
        assert await repository.latest_reported_at("2600:1f18:0:0::1") == stored_time
        assert await repository.latest_reported_at("8.8.8.8") is None


async def test_reported_ips_keeps_the_latest_row_per_ip_inside_the_window(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    two_hours_ago = now - timedelta(hours=2)
    since = now - timedelta(days=90)
    await _store(
        pg_session_maker,
        _report("3.5.140.2", now - timedelta(days=100)),
        _report("3.5.140.2", now - timedelta(days=10), status="sent"),
        _report("3.5.140.2", two_hours_ago, status="unconfirmed"),
        _report("8.8.8.8", now - timedelta(days=91)),
        _report("1.1.1.1", since),
    )

    async with pg_session_maker() as session:
        reported = await AbuseIpdbReportRepository(session=session, wrap_exceptions=False).reported_ips(since)

    assert reported == [
        ReportedIp("1.1.1.1", since, "sent"),
        ReportedIp("3.5.140.2", two_hours_ago, "unconfirmed"),
    ]


async def _page(pg_session_maker, *, limit: int = 10, offset: int = 0, **filters):
    async with pg_session_maker() as session:
        repository = AbuseIpdbReportRepository(session=session, wrap_exceptions=False)
        return await repository.list_page(limit=limit, offset=offset, **filters)


async def test_list_page_is_newest_first_and_counts_past_the_page(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(pg_session_maker, *[_report("3.5.140.2", now - timedelta(hours=age)) for age in (3, 1, 2)])

    rows, total = await _page(pg_session_maker, limit=2, offset=1)

    assert [row.reported_at for row in rows] == [now - timedelta(hours=2), now - timedelta(hours=3)]
    assert total == 3
    assert all(isinstance(row.ip_address, str) for row in rows)


async def test_list_page_shows_each_report_of_a_reported_twice_ip(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(pg_session_maker, _report("3.5.140.2", now), _report("3.5.140.2", now - timedelta(days=1)))

    rows, total = await _page(pg_session_maker)

    assert total == 2 and len(rows) == 2


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        ("3.5.1", {"3.5.140.2", "3.5.140.20"}),
        ("3.5.140.2", {"3.5.140.2"}),
        ("5.140", set()),
        ("2600:1F18", {"2600:1f18::1"}),
        ("2600:1F18:0::1", {"2600:1f18::1"}),
        ("WORDPRESS", {"8.8.4.4"}),
        ("homepage", {"9.9.9.9"}),
        ("%", {"1.0.0.1"}),
        ("2600:1f18::1%eth0", set()),
        ("2600:1F18:0::", {"2600:1f18::1"}),
    ],
    ids=[
        "ip-start",
        "whole-ip-is-exact",
        "ip-middle",
        "ipv6-case",
        "ipv6-spelling",
        "comment-case",
        "sent-by",
        "percent-is-literal",
        "ipv6-zone-is-text",
        "ipv6-network-is-prefix",
    ],
)
async def test_list_page_search(pg_session_maker, clean_abuseipdb_reports, q, expected):
    now = datetime.now(UTC)
    await _store(
        pg_session_maker,
        _report("3.5.140.2", now),
        _report("3.5.140.20", now),
        _report("2600:1f18::1", now),
        _report("8.8.4.4", now, comment="Probed wordpress paths"),
        _report("9.9.9.9", now, reporter_kind="api_key", reporter_name="homepage"),
        _report("1.0.0.1", now, comment="100% scanner"),
    )

    rows, total = await _page(pg_session_maker, q=q)

    assert {row.ip_address for row in rows} == expected
    assert total == len(expected)


async def test_list_page_filters_by_category(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(pg_session_maker, _report("3.5.140.2", now, categories=[14]), _report("8.8.8.8", now, categories=[14, 21]))
    await _store(pg_session_maker, _report("9.9.9.9", now, categories=[21]))

    rows, total = await _page(pg_session_maker, categories=[14])

    assert {row.ip_address for row in rows} == {"3.5.140.2", "8.8.8.8"}
    assert total == 2


async def test_list_page_matches_any_of_several_categories(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(
        pg_session_maker,
        _report("3.5.140.2", now, categories=[14]),
        _report("8.8.8.8", now, categories=[21]),
        _report("9.9.9.9", now, categories=[18]),
    )

    rows, total = await _page(pg_session_maker, categories=[14, 21])

    assert {row.ip_address for row in rows} == {"3.5.140.2", "8.8.8.8"}
    assert total == 2


async def test_list_page_filters_by_status(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(pg_session_maker, _report("3.5.140.2", now), _report("8.8.8.8", now, status="unconfirmed"))

    rows, total = await _page(pg_session_maker, statuses=["unconfirmed"])

    assert [row.ip_address for row in rows] == ["8.8.8.8"]
    assert total == 1

    rows, total = await _page(pg_session_maker, statuses=["sent", "unconfirmed"])

    assert total == 2


async def test_list_page_filters_combine(pg_session_maker, clean_abuseipdb_reports):
    now = datetime.now(UTC)
    await _store(
        pg_session_maker,
        _report("3.5.140.2", now, categories=[14]),
        _report("3.5.140.3", now, categories=[21]),
        _report("8.8.8.8", now, categories=[14]),
    )

    rows, total = await _page(pg_session_maker, q="3.5.", categories=[14])

    assert [row.ip_address for row in rows] == ["3.5.140.2"]
    assert total == 1
