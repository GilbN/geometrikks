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


@pytest.mark.parametrize("overrides", [{"status": "failed"}, {"reporter_kind": "robot"}])
async def test_status_and_reporter_kind_are_constrained(pg_session_maker, clean_abuseipdb_reports, overrides):
    with pytest.raises(IntegrityError):
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
    await _store(
        pg_session_maker,
        _report("3.5.140.2", now - timedelta(days=100)),
        _report("3.5.140.2", two_hours_ago, status="unconfirmed"),
        _report("8.8.8.8", now - timedelta(days=91)),
    )

    async with pg_session_maker() as session:
        reported = await AbuseIpdbReportRepository(session=session, wrap_exceptions=False).reported_ips(
            now - timedelta(days=90)
        )

    assert reported == [ReportedIp("3.5.140.2", two_hours_ago, "unconfirmed")]
