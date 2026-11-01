"""DROP refresh against the real tables: import, skip rules, unchanged feeds and failed downloads."""
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from sqlalchemy import text
from structlog.testing import capture_logs

from geometrikks.domain.drop.refresh import refresh_drop_lists

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
V4_LINES = (
    '{"cidr":"192.0.2.0/24","sblid":"SBL000002","rir":"apnic"}',
    '{"cidr":"198.51.100.64/26","sblid":"SBL000001","rir":"ripencc"}',
)
V6_LINES = ('{"cidr":"2001:db8:254::/48","sblid":"SBL000003","rir":"ripencc"}',)
ASN_LINES = ('{"asn":64496,"rir":"ripencc","domain":"example.net","cc":"NL","asname":"EXAMPLE-AS"}',)


def feed_body(lines: tuple[str, ...], *, timestamp: int = 1793535242) -> bytes:
    metadata = (
        f'{{"type":"metadata","timestamp":{timestamp},"size":1,"records":{len(lines)},'
        '"copyright":"(c) 2026 The Spamhaus Project SLU"}'
    )
    return ("\n".join((*lines, metadata)) + "\n").encode()


class FeedServer:
    """A MockTransport that serves one body per feed URL and counts the requests."""

    def __init__(self, bodies_by_path: dict[str, bytes]) -> None:
        self.bodies_by_path = bodies_by_path
        self.requested_paths: list[str] = []
        self.transport = httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requested_paths.append(request.url.path)
        return httpx2.Response(200, content=self.bodies_by_path[request.url.path])


def default_server(**overrides: bytes) -> FeedServer:
    bodies_by_path = {
        "/drop/drop_v4.json": feed_body(V4_LINES),
        "/drop/drop_v6.json": feed_body(V6_LINES),
        "/drop/asndrop.json": feed_body(ASN_LINES),
    }
    bodies_by_path.update(overrides)
    return FeedServer(bodies_by_path)


async def fetch_cidrs(pg_session_maker) -> set[str]:
    async with pg_session_maker() as session:
        return set((await session.execute(text("SELECT cidr::text FROM drop_networks"))).scalars().all())


async def fetch_state(pg_session_maker, feed: str):
    async with pg_session_maker() as session:
        return (
            await session.execute(text("SELECT * FROM drop_list_state WHERE feed = :feed"), {"feed": feed})
        ).one()


async def test_first_import_inserts_every_row_and_the_state_rows(pg_session_maker, clean_tables):
    server = default_server()

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=NOW, transport=server.transport)

    assert [(outcome.feed, outcome.status, outcome.records) for outcome in feed_outcomes] == [
        ("v4", "imported", 2),
        ("v6", "imported", 1),
        ("asn", "imported", 1),
    ]
    assert await fetch_cidrs(pg_session_maker) == {"192.0.2.0/24", "198.51.100.64/26", "2001:db8:254::/48"}
    async with pg_session_maker() as session:
        asn_rows = (await session.execute(text("SELECT asn, name, country_code FROM drop_asns"))).all()
    assert [tuple(asn_row) for asn_row in asn_rows] == [(64496, "EXAMPLE-AS", "NL")]
    v4_state = await fetch_state(pg_session_maker, "v4")
    assert v4_state.upstream_timestamp == datetime.fromtimestamp(1793535242, UTC)
    assert v4_state.record_count == 2
    assert v4_state.copyright == "(c) 2026 The Spamhaus Project SLU"
    assert v4_state.fetched_at == NOW
    assert v4_state.checked_at == NOW
    assert v4_state.last_error is None


async def test_a_run_within_the_hour_fetches_nothing(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server()

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=NOW + timedelta(minutes=30), transport=server.transport
    )

    assert server.requested_paths == []
    assert {(outcome.status, outcome.reason) for outcome in feed_outcomes} == {
        ("skipped", "checked less than an hour ago")
    }


async def test_the_same_upstream_timestamp_counts_as_a_fresh_fetch(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE drop_list_state SET last_error = 'HTTP 503' WHERE feed = 'v4'"))
    server = default_server()
    later = NOW + timedelta(hours=2)

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=later, transport=server.transport)

    assert [outcome.status for outcome in feed_outcomes] == ["unchanged"] * 3
    assert len(server.requested_paths) == 3
    assert await fetch_cidrs(pg_session_maker) == {"192.0.2.0/24", "198.51.100.64/26", "2001:db8:254::/48"}
    v4_state = await fetch_state(pg_session_maker, "v4")
    assert v4_state.checked_at == later
    assert v4_state.fetched_at == later
    assert v4_state.last_error is None


async def test_a_new_v4_body_replaces_the_v4_rows_and_leaves_the_v6_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    new_v4_body = feed_body(('{"cidr":"203.0.113.128/25","sblid":"SBL000005","rir":"ripencc"}',), timestamp=1793600000)
    server = default_server(**{"/drop/drop_v4.json": new_v4_body})

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=NOW + timedelta(hours=2), transport=server.transport)

    assert feed_outcomes[0].status == "imported"
    assert await fetch_cidrs(pg_session_maker) == {"203.0.113.128/25", "2001:db8:254::/48"}
    assert (await fetch_state(pg_session_maker, "v4")).record_count == 1


async def test_a_new_v6_body_leaves_the_v4_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    new_v6_body = feed_body(('{"cidr":"2001:db8:ff00::/40","sblid":"SBL000006","rir":"ripencc"}',), timestamp=1793600000)
    server = default_server(**{"/drop/drop_v6.json": new_v6_body})

    await refresh_drop_lists(pg_session_maker, now=NOW + timedelta(hours=2), transport=server.transport)

    assert await fetch_cidrs(pg_session_maker) == {"192.0.2.0/24", "198.51.100.64/26", "2001:db8:ff00::/40"}


async def test_an_html_body_fails_the_feed_and_keeps_the_old_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server(**{"/drop/drop_v4.json": b"<html><body>Blocked</body></html>"})
    later = NOW + timedelta(hours=2)

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=later, transport=server.transport)

    assert [outcome.status for outcome in feed_outcomes] == ["failed", "unchanged", "unchanged"]
    assert feed_outcomes[0].reason == "invalid line 1"
    assert await fetch_cidrs(pg_session_maker) == {"192.0.2.0/24", "198.51.100.64/26", "2001:db8:254::/48"}
    v4_state = await fetch_state(pg_session_maker, "v4")
    assert v4_state.last_error == "invalid line 1"
    assert v4_state.checked_at == later
    assert v4_state.fetched_at == NOW


async def test_a_first_ever_failure_creates_the_state_row(pg_session_maker, clean_tables):
    server = default_server(**{"/drop/asndrop.json": b"not a feed"})

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=NOW, transport=server.transport)

    assert [outcome.status for outcome in feed_outcomes] == ["imported", "imported", "failed"]
    asn_state = await fetch_state(pg_session_maker, "asn")
    assert asn_state.last_error == "invalid line 1"
    assert asn_state.fetched_at is None


async def test_an_unexpected_error_fails_only_its_own_feed(pg_session_maker, clean_tables):
    def handle(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/drop/drop_v6.json":
            raise ValueError("boom")
        return httpx2.Response(200, content=default_server().bodies_by_path[request.url.path])

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=NOW, transport=httpx2.MockTransport(handle)
    )

    assert [(outcome.status, outcome.reason) for outcome in feed_outcomes] == [
        ("imported", None),
        ("failed", "unexpected error: ValueError"),
        ("imported", None),
    ]
    assert (await fetch_state(pg_session_maker, "v6")).last_error == "unexpected error: ValueError"


async def test_startup_skips_a_feed_fetched_within_the_refresh_interval(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server()

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=NOW + timedelta(hours=1), startup=True, transport=server.transport
    )

    assert server.requested_paths == []
    assert {(outcome.status, outcome.reason) for outcome in feed_outcomes} == {("skipped", "fresh")}


async def test_startup_fetches_a_feed_last_fetched_before_the_refresh_interval(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server()

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=NOW + timedelta(hours=25), startup=True, transport=server.transport
    )

    assert len(server.requested_paths) == 3
    assert [outcome.status for outcome in feed_outcomes] == ["unchanged"] * 3


async def test_a_failure_inside_the_replace_transaction_keeps_the_old_rows(
    pg_session_maker, clean_tables, monkeypatch
):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    new_v4_body = feed_body(('{"cidr":"203.0.113.128/25","sblid":"SBL000005","rir":"ripencc"}',), timestamp=1793600000)

    async def fail_after_the_rows_changed(*args, **kwargs):
        raise RuntimeError("state write failed")

    monkeypatch.setattr("geometrikks.domain.drop.refresh._upsert_state", fail_after_the_rows_changed)
    later = NOW + timedelta(hours=2)

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=later, transport=default_server(**{"/drop/drop_v4.json": new_v4_body}).transport
    )

    assert feed_outcomes[0].status == "failed"
    assert await fetch_cidrs(pg_session_maker) == {"192.0.2.0/24", "198.51.100.64/26", "2001:db8:254::/48"}
    v4_state = await fetch_state(pg_session_maker, "v4")
    assert v4_state.last_error == "unexpected error: RuntimeError"
    assert v4_state.checked_at == later
    assert v4_state.record_count == 2


async def test_each_outcome_is_logged_with_its_feed(pg_session_maker, clean_tables):
    with capture_logs() as imported_logs:
        await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    with capture_logs() as skipped_logs:
        await refresh_drop_lists(
            pg_session_maker, now=NOW + timedelta(minutes=30), transport=default_server().transport
        )
    with capture_logs() as failed_logs:
        await refresh_drop_lists(
            pg_session_maker,
            now=NOW + timedelta(hours=2),
            transport=default_server(**{"/drop/asndrop.json": b"not a feed"}).transport,
        )

    assert [(log["event"], log["feed"]) for log in imported_logs] == [
        ("drop_lists_refreshed", "v4"),
        ("drop_lists_refreshed", "v6"),
        ("drop_lists_refreshed", "asn"),
    ]
    assert [(log["event"], log["feed"]) for log in skipped_logs] == [
        ("drop_list_refresh_skipped", "v4"),
        ("drop_list_refresh_skipped", "v6"),
        ("drop_list_refresh_skipped", "asn"),
    ]
    failed_log = next(log for log in failed_logs if log["event"] == "drop_list_refresh_failed")
    assert failed_log["feed"] == "asn"
    assert failed_log["reason"] == "invalid line 1"
