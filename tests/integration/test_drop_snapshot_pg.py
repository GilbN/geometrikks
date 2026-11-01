"""DROP snapshot loading, throttling and the drop ASN category through the real app."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import structlog
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from structlog.testing import capture_logs

from geometrikks.config.settings import (
    DatabaseSettings,
    DropSettings,
    MapSettings,
    SchedulerSettings,
    Settings,
)
from geometrikks.domain.drop import snapshot as snapshot_module
from geometrikks.domain.drop.refresh import refresh_drop_lists
from geometrikks.domain.drop.snapshot import (
    DropAsnEntry,
    DropNetworkMatch,
    current_drop_snapshot,
    ensure_drop_snapshot,
)
from geometrikks.server.core import create_app
from tests.integration.test_analytics_endpoints import _insert_asn_log
from tests.integration.test_drop_refresh_pg import default_server
from tests.integration.test_geo_logs_asn_pg import seed_asn_raw

pytestmark = pytest.mark.anyio

NOW = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
IMPORTED_AT = NOW - timedelta(hours=2)
WINDOW = {"startDate": (NOW - timedelta(hours=2)).isoformat(), "endDate": (NOW + timedelta(hours=1)).isoformat()}


class FakeClock:
    def __init__(self) -> None:
        self.seconds = 1000.0

    def __call__(self) -> float:
        return self.seconds


@pytest.fixture()
def fake_clock(monkeypatch) -> FakeClock:
    clock = FakeClock()
    monkeypatch.setattr(snapshot_module, "_clock", clock)
    return clock


@pytest.fixture(autouse=True)
def _reset_structlog_config():
    """Undo the StructlogPlugin's cache_logger_on_first_use configuration (see test_geo_locations_api_pg)."""
    from geometrikks.server.logging import ensure_default_configuration

    yield
    structlog.reset_defaults()
    ensure_default_configuration()


def build_settings(migrated_database_url: str, *, drop_enabled: bool = True) -> Settings:
    url = make_url(migrated_database_url)
    assert url.host is not None and url.username is not None
    assert url.password is not None and url.database is not None
    return Settings(
        auth_disabled=True,
        database=DatabaseSettings(
            host=url.host, port=url.port or 5432, user=url.username, password=url.password, database=url.database
        ),
        scheduler=SchedulerSettings(enabled=False),
        map=MapSettings(server_latitude=59.91, server_longitude=10.75),
        drop=DropSettings(enabled=drop_enabled),
    )


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    return build_settings(migrated_database_url)


async def import_fixture_lists(pg_session_maker, *, now: datetime = IMPORTED_AT) -> None:
    await refresh_drop_lists(pg_session_maker, now=now, transport=default_server().transport)


async def test_ensure_loads_the_imported_rows(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)

    async with pg_session_maker() as session:
        drop_snapshot = await ensure_drop_snapshot(session, enabled=True)

    assert drop_snapshot.loaded
    assert drop_snapshot.updated_at == IMPORTED_AT
    assert current_drop_snapshot() is drop_snapshot
    assert drop_snapshot.network_for("198.51.100.100") == DropNetworkMatch("198.51.100.64/26", "SBL000001")
    assert drop_snapshot.network_for("::ffff:198.51.100.100") == DropNetworkMatch("198.51.100.64/26", "SBL000001")
    assert drop_snapshot.network_for("2001:db8:254::1") == DropNetworkMatch("2001:db8:254::/48", "SBL000003")
    assert drop_snapshot.asn_entry(64496) == DropAsnEntry(asn=64496, name="EXAMPLE-AS", country_code="NL")
    assert {feed.feed for feed in drop_snapshot.feeds} == {"v4", "v6", "asn"}
    assert len(drop_snapshot.networks) == 3


async def test_ensure_is_empty_before_any_import(pg_session_maker, clean_tables, fake_clock):
    async with pg_session_maker() as session:
        drop_snapshot = await ensure_drop_snapshot(session, enabled=True)

    assert not drop_snapshot.loaded
    assert drop_snapshot.networks == ()


async def test_second_call_within_a_minute_does_not_query(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        first = await ensure_drop_snapshot(session, enabled=True)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE drop_list_state SET fetched_at = fetched_at + interval '1 hour'"))

    fake_clock.seconds += 59
    async with pg_session_maker() as session:
        second = await ensure_drop_snapshot(session, enabled=True)

    assert second is first


async def test_reloads_after_the_clock_advances_and_fetched_at_changes(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        first = await ensure_drop_snapshot(session, enabled=True)
    later = IMPORTED_AT + timedelta(hours=3)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM drop_networks WHERE sbl_id = 'SBL000001'"))
        await session.execute(text("UPDATE drop_list_state SET fetched_at = :later"), {"later": later})

    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        second = await ensure_drop_snapshot(session, enabled=True)

    assert second is not first
    assert second.updated_at == later
    assert second.network_for("198.51.100.100") is None


async def test_unchanged_timestamps_keep_the_loaded_snapshot(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        first = await ensure_drop_snapshot(session, enabled=True)

    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        second = await ensure_drop_snapshot(session, enabled=True)

    assert second is first


async def test_a_new_check_alone_reloads_the_feed_states(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        first = await ensure_drop_snapshot(session, enabled=True)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE drop_list_state SET checked_at = checked_at + interval '1 hour', last_error = 'HTTP 503'"))

    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        second = await ensure_drop_snapshot(session, enabled=True)

    assert second is not first
    assert {feed.last_error for feed in second.feeds} == {"HTTP 503"}


async def test_a_last_error_with_an_unchanged_check_reloads_the_feed_states(
    pg_session_maker, clean_tables, fake_clock
):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        first = await ensure_drop_snapshot(session, enabled=True)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE drop_list_state SET last_error = 'HTTP 503' WHERE feed = 'asn'"))

    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        second = await ensure_drop_snapshot(session, enabled=True)

    assert second is not first
    assert {feed.feed: feed.last_error for feed in second.feeds} == {"v4": None, "v6": None, "asn": "HTTP 503"}


class UnreachableSession:
    """Stands in for a session whose database has gone away."""

    def __init__(self) -> None:
        self.execute_calls = 0
        self.rollback_calls = 0

    async def execute(self, *args, **kwargs):
        self.execute_calls += 1
        raise OperationalError("SELECT feed FROM drop_list_state", {}, ConnectionRefusedError("connection refused"))

    async def rollback(self) -> None:
        self.rollback_calls += 1


async def test_a_database_error_keeps_the_loaded_snapshot(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        loaded = await ensure_drop_snapshot(session, enabled=True)
    unreachable_session = UnreachableSession()

    fake_clock.seconds += 61
    with capture_logs() as reload_logs:
        during_outage = await ensure_drop_snapshot(unreachable_session, enabled=True)  # ty: ignore[invalid-argument-type]
    fake_clock.seconds += 59
    still_cached = await ensure_drop_snapshot(unreachable_session, enabled=True)  # ty: ignore[invalid-argument-type]

    assert during_outage is loaded
    assert still_cached is loaded
    assert unreachable_session.execute_calls == 1
    assert unreachable_session.rollback_calls == 1
    assert [(log["event"], log["log_level"]) for log in reload_logs] == [("drop_snapshot_reload_failed", "warning")]


async def test_a_database_error_before_the_first_load_propagates(clean_tables, fake_clock):
    with pytest.raises(OperationalError):
        await ensure_drop_snapshot(UnreachableSession(), enabled=True)  # ty: ignore[invalid-argument-type]


async def test_disabled_returns_an_empty_snapshot_even_with_rows(pg_session_maker, clean_tables, fake_clock):
    await import_fixture_lists(pg_session_maker)
    async with pg_session_maker() as session:
        loaded = await ensure_drop_snapshot(session, enabled=True)
    reload_lock = snapshot_module._reload_lock

    async with pg_session_maker() as session:
        disabled = await ensure_drop_snapshot(session, enabled=False)

    assert not disabled.loaded
    assert disabled.network_for("198.51.100.100") is None
    assert current_drop_snapshot() is loaded
    assert snapshot_module._reload_lock is reload_lock

    async with pg_session_maker() as session:
        enabled_again = await ensure_drop_snapshot(session, enabled=True)
    assert enabled_again.loaded


async def test_reload_between_feed_commits_still_picks_up_the_later_feed(pg_session_maker, clean_tables, fake_clock):
    """A refresh stamps every feed with one timestamp and commits them one at a time, ASN last."""
    await import_fixture_lists(pg_session_maker)
    refreshed_at = IMPORTED_AT + timedelta(hours=24)
    async with pg_session_maker() as session:
        await ensure_drop_snapshot(session, enabled=True)

    async with pg_session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM drop_networks WHERE sbl_id = 'SBL000001'"))
        await session.execute(
            text("UPDATE drop_list_state SET fetched_at = :at, checked_at = :at WHERE feed = 'v4'"),
            {"at": refreshed_at},
        )
    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        after_v4 = await ensure_drop_snapshot(session, enabled=True)
    assert after_v4.network_for("198.51.100.100") is None
    assert after_v4.is_drop_asn(64496)

    async with pg_session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM drop_asns"))
        await session.execute(text("INSERT INTO drop_asns (asn, name, country_code) VALUES (64499, 'NEWASN', 'NO')"))
        await session.execute(
            text("UPDATE drop_list_state SET fetched_at = :at, checked_at = :at WHERE feed = 'asn'"),
            {"at": refreshed_at},
        )
    fake_clock.seconds += 61
    async with pg_session_maker() as session:
        after_asn = await ensure_drop_snapshot(session, enabled=True)

    assert after_asn.is_drop_asn(64499)
    assert not after_asn.is_drop_asn(64496)


async def seed_drop_asn_traffic(pg_session_maker) -> None:
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_asn_log(session, ts=ts, asn=64496, asn_org="EXAMPLE-AS", bytes_sent=200)
        await _insert_asn_log(session, ts=ts, asn=24940, asn_org="Hetzner Online GmbH")
        await session.commit()


async def test_top_asns_has_no_drop_category_before_an_import(app_settings, pg_session_maker, clean_tables):
    await seed_drop_asn_traffic(pg_session_maker)

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/analytics/top-asns", params=WINDOW)

    assert response.status_code == 200
    body = response.json()
    assert [category["category"] for category in body["categories"]] == ["hosting", "other"]
    assert {item["asn"]: item["category"] for item in body["items"]} == {64496: "other", 24940: "hosting"}
    assert body["dropAsnCount"] is None


async def test_top_asns_lists_drop_first_after_an_import(app_settings, pg_session_maker, clean_tables):
    await seed_drop_asn_traffic(pg_session_maker)
    await import_fixture_lists(pg_session_maker)

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/analytics/top-asns", params=WINDOW)

    assert response.status_code == 200
    body = response.json()
    assert [(category["category"], category["hits"], category["totalBytes"]) for category in body["categories"]] == [
        ("drop", 3, 600),
        ("hosting", 1, 100),
        ("other", 0, 0),
    ]
    assert {item["asn"]: item["category"] for item in body["items"]} == {64496: "drop", 24940: "hosting"}
    assert body["dropAsnCount"] == 1


async def test_top_asns_counts_drop_asns_beyond_the_returned_items(app_settings, pg_session_maker, clean_tables):
    await seed_drop_asn_traffic(pg_session_maker)
    async with pg_session_maker() as session:
        for _ in range(5):
            await _insert_asn_log(session, ts=NOW - timedelta(hours=1), asn=24940, asn_org="Hetzner Online GmbH")
        await session.commit()
    await import_fixture_lists(pg_session_maker)

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/analytics/top-asns", params={**WINDOW, "limit": 1})

    assert response.status_code == 200
    body = response.json()
    assert [item["asn"] for item in body["items"]] == [24940]
    assert body["dropAsnCount"] == 1


async def test_top_asns_ignores_imported_rows_when_disabled(migrated_database_url, pg_session_maker, clean_tables):
    await seed_drop_asn_traffic(pg_session_maker)
    await import_fixture_lists(pg_session_maker)
    disabled_settings = build_settings(migrated_database_url, drop_enabled=False)

    async with AsyncTestClient(app=create_app(settings=disabled_settings)) as client:
        response = await client.get("/api/v1/analytics/top-asns", params=WINDOW)

    assert response.status_code == 200
    body = response.json()
    assert [category["category"] for category in body["categories"]] == ["hosting", "other"]
    assert {item["asn"]: item["category"] for item in body["items"]}[64496] == "other"
    assert body["dropAsnCount"] is None


async def test_top_asns_has_no_drop_category_until_the_asn_feed_downloads(
    app_settings, pg_session_maker, clean_tables
):
    await seed_drop_asn_traffic(pg_session_maker)
    await refresh_drop_lists(
        pg_session_maker,
        now=IMPORTED_AT,
        transport=default_server(**{"/drop/asndrop.json": b"<html>blocked</html>"}).transport,
    )

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        top_asns_response = await client.get("/api/v1/analytics/top-asns", params=WINDOW)
        lists_response = await client.get("/api/v1/drop/lists")

    assert top_asns_response.status_code == 200
    top_asns = top_asns_response.json()
    assert [category["category"] for category in top_asns["categories"]] == ["hosting", "other"]
    assert top_asns["dropAsnCount"] is None
    assert lists_response.json()["loaded"] is True
    assert len(lists_response.json()["networks"]) == 3


async def test_ip_profile_reports_the_drop_category(app_settings, pg_session_maker, clean_tables):
    await seed_drop_asn_traffic(pg_session_maker)
    await import_fixture_lists(pg_session_maker)

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get("/api/v1/analytics/ip-profile", params={**WINDOW, "ipAddress": "10.0.0.1"})

    assert response.status_code == 200
    assert response.json()["asnCategory"] == "drop"


async def test_geo_top_asns_reports_the_drop_category(app_settings, pg_session_maker, clean_tables):
    await seed_asn_raw(pg_session_maker)
    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO drop_asns (asn, name, country_code) VALUES (24940, 'HETZNER', 'DE')"))
        await session.execute(text(
            "INSERT INTO drop_list_state (feed, fetched_at, checked_at) VALUES ('asn', now(), now())"
        ))
        await session.commit()

    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        response = await client.get(
            "/api/v1/geo-events/top-asns",
            params={"fromTimestamp": (NOW - timedelta(hours=23)).isoformat(), "toTimestamp": NOW.isoformat()},
        )

    assert response.status_code == 200
    assert {item["asn"]: item["category"] for item in response.json()["items"]} == {1221: "other", 24940: "drop"}
