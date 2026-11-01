"""About's database card against a migrated database."""
from __future__ import annotations

from datetime import UTC, datetime

import pytest
from litestar.testing import AsyncTestClient
from structlog.testing import capture_logs
from sqlalchemy.ext.asyncio import AsyncEngine

from geometrikks.domain.drop.refresh import refresh_drop_lists
from geometrikks.domain.system.controllers.system import _database_versions
from geometrikks.server.core import create_app
from geometrikks.server.schema_wait import bundled_head_revision, bundled_revision_doc
from tests.integration.test_drop_refresh_pg import default_server
from tests.integration.test_drop_snapshot_pg import (  # noqa: F401  (autouse structlog reset)
    _reset_structlog_config,
    build_settings,
    import_fixture_lists,
)

pytestmark = pytest.mark.anyio


async def test_database_versions_report_the_migration_the_db_is_on(pg_engine: AsyncEngine):
    versions = await _database_versions(pg_engine)
    head = bundled_head_revision()
    assert versions.migration_revision == head
    assert versions.migration_head == head
    assert versions.migration_name == bundled_revision_doc(head)


async def fetch_about(settings) -> dict:
    async with AsyncTestClient(app=create_app(settings=settings)) as client:
        response = await client.get("/api/v1/system/about")
    assert response.status_code == 200
    return response.json()


async def test_about_carries_the_per_feed_state_and_the_last_error(
    migrated_database_url, pg_session_maker, clean_tables
):
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    server = default_server(**{"/drop/asndrop.json": b"not a feed"})
    await refresh_drop_lists(pg_session_maker, now=now, transport=server.transport)

    about = await fetch_about(build_settings(migrated_database_url))

    drop_lists = about["dropLists"]
    assert drop_lists["enabled"] is True
    assert drop_lists["loaded"] is True
    assert drop_lists["stale"] is False
    assert drop_lists["termsUrl"] == "https://www.spamhaus.org/drop/terms/"
    assert drop_lists["copyright"] == "(c) 2026 The Spamhaus Project SLU"
    feeds_by_name = {feed["feed"]: feed for feed in drop_lists["feeds"]}
    assert feeds_by_name["v4"]["recordCount"] == 2
    assert feeds_by_name["v4"]["lastError"] is None
    assert feeds_by_name["asn"]["lastError"] == "invalid line 1"
    assert feeds_by_name["asn"]["fetchedAt"] is None


async def test_about_lists_the_feeds_before_anything_downloaded(migrated_database_url, pg_session_maker, clean_tables):
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    bad_body = b"<html>blocked</html>"
    server = default_server(
        **{"/drop/drop_v4.json": bad_body, "/drop/drop_v6.json": bad_body, "/drop/asndrop.json": bad_body}
    )
    await refresh_drop_lists(pg_session_maker, now=now, transport=server.transport)

    about = await fetch_about(build_settings(migrated_database_url))

    drop_lists = about["dropLists"]
    assert drop_lists["loaded"] is False
    assert drop_lists["updatedAt"] is None
    assert [feed["feed"] for feed in drop_lists["feeds"]] == ["v4", "v6", "asn"]
    assert all(feed["lastError"] and feed["fetchedAt"] is None for feed in drop_lists["feeds"])


async def test_about_has_no_drop_lists_when_disabled(migrated_database_url, pg_session_maker, clean_tables):

    await import_fixture_lists(pg_session_maker)

    about = await fetch_about(build_settings(migrated_database_url, drop_enabled=False))

    assert about["dropLists"] is None


async def test_about_lists_no_feeds_on_a_fresh_install(migrated_database_url, pg_session_maker, clean_tables):
    about = await fetch_about(build_settings(migrated_database_url))

    drop_lists = about["dropLists"]
    assert drop_lists["enabled"] is True
    assert drop_lists["loaded"] is False
    assert drop_lists["feeds"] == []


async def test_about_drops_the_drop_card_when_the_snapshot_cannot_load(
    migrated_database_url, pg_session_maker, clean_tables, monkeypatch
):
    async def fail_to_load(session, *, enabled):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("geometrikks.domain.system.controllers.system.ensure_drop_snapshot", fail_to_load)

    async with AsyncTestClient(app=create_app(settings=build_settings(migrated_database_url))) as client:
        with capture_logs() as captured_logs:
            response = await client.get("/api/v1/system/about")

    assert response.status_code == 200
    about = response.json()
    assert about["dropLists"] is None
    assert about["database"]["postgresVersion"] is not None
    assert "drop_lists_about_unavailable" in [log["event"] for log in captured_logs]
