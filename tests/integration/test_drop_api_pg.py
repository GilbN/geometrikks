"""GET /api/v1/drop/lists against a migrated database."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from litestar.testing import AsyncTestClient
from sqlalchemy import text

from geometrikks.config.settings import Settings
from geometrikks.domain.drop.refresh import refresh_drop_lists
from geometrikks.server.core import create_app
from tests.integration.test_drop_refresh_pg import default_server
from tests.integration.test_drop_snapshot_pg import build_settings, import_fixture_lists

pytestmark = pytest.mark.anyio

NOW = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    return build_settings(migrated_database_url)


async def test_lists_are_empty_before_an_import(app_settings, pg_session_maker, clean_tables):
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/drop/lists")

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["loaded"] is False
    assert body["updatedAt"] is None
    assert body["stale"] is False
    assert body["copyright"] is None
    assert body["networks"] == []
    assert body["asns"] == []
    assert body["feeds"] == []


async def test_lists_carry_the_imported_rows_in_camel_case(app_settings, pg_session_maker, clean_tables):
    await import_fixture_lists(pg_session_maker)

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/drop/lists")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, max-age=300"
    body = response.json()
    assert body["enabled"] is True
    assert body["loaded"] is True
    assert body["stale"] is False
    assert body["copyright"] == "(c) 2026 The Spamhaus Project SLU"
    assert {"cidr": "45.148.10.0/24", "sblId": "SBL678435"} in body["networks"]
    assert {"cidr": "2001:678:254::/48", "sblId": "SBL697648"} in body["networks"]
    assert body["asns"] == [{"asn": 48090, "name": "TECHOFF"}]
    assert [feed["feed"] for feed in body["feeds"]] == ["v4", "v6", "asn"]
    v4_feed = body["feeds"][0]
    assert set(v4_feed) == {"feed", "recordCount", "upstreamTimestamp", "fetchedAt", "checkedAt", "lastError"}
    assert v4_feed["recordCount"] == 2
    assert v4_feed["lastError"] is None


async def test_lists_are_hidden_when_disabled_even_with_rows(migrated_database_url, pg_session_maker, clean_tables):
    await import_fixture_lists(pg_session_maker)
    disabled_settings = build_settings(migrated_database_url, drop_enabled=False)

    async with AsyncTestClient(app=create_app(settings=disabled_settings)) as client:
        response = await client.get("/api/v1/drop/lists")

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["loaded"] is False
    assert body["updatedAt"] is None
    assert body["networks"] == []
    assert body["asns"] == []
    assert body["feeds"] == []


async def test_lists_are_stale_when_nothing_was_fetched_for_a_week(app_settings, pg_session_maker, clean_tables):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE drop_list_state SET fetched_at = :old"), {"old": NOW - timedelta(days=8)})

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/drop/lists")

    body = response.json()
    assert body["loaded"] is True
    assert body["stale"] is True


async def test_a_failed_first_download_shows_the_error_without_loading(app_settings, pg_session_maker, clean_tables):
    server = default_server(**{"/drop/drop_v4.json": b"<html>blocked</html>"})
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=server.transport)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM drop_list_state WHERE feed <> 'v4'"))

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/drop/lists")

    body = response.json()
    assert body["loaded"] is False
    assert body["updatedAt"] is None
    assert len(body["feeds"]) == 1
    assert body["feeds"][0]["feed"] == "v4"
    assert body["feeds"][0]["fetchedAt"] is None
    assert body["feeds"][0]["lastError"]
