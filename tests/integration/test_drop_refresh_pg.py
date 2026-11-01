"""DROP refresh against the real tables: import, skip rules, unchanged feeds and failed downloads."""
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from sqlalchemy import text

from geometrikks.domain.drop.refresh import refresh_drop_lists

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
V4_LINES = (
    '{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}',
    '{"cidr":"45.148.10.0/24","sblid":"SBL678435","rir":"ripencc"}',
)
V6_LINES = ('{"cidr":"2001:678:254::/48","sblid":"SBL697648","rir":"ripencc"}',)
ASN_LINES = ('{"asn":48090,"rir":"ripencc","domain":"techoff.example","cc":"NL","asname":"TECHOFF"}',)


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
    assert await fetch_cidrs(pg_session_maker) == {"1.10.16.0/20", "45.148.10.0/24", "2001:678:254::/48"}
    async with pg_session_maker() as session:
        asn_rows = (await session.execute(text("SELECT asn, name, country_code FROM drop_asns"))).all()
    assert [tuple(asn_row) for asn_row in asn_rows] == [(48090, "TECHOFF", "NL")]
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


async def test_the_same_upstream_timestamp_only_updates_checked_at(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server()
    later = NOW + timedelta(hours=2)

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=later, transport=server.transport)

    assert [outcome.status for outcome in feed_outcomes] == ["unchanged"] * 3
    assert len(server.requested_paths) == 3
    assert await fetch_cidrs(pg_session_maker) == {"1.10.16.0/20", "45.148.10.0/24", "2001:678:254::/48"}
    v4_state = await fetch_state(pg_session_maker, "v4")
    assert v4_state.checked_at == later
    assert v4_state.fetched_at == NOW


async def test_a_new_v4_body_replaces_the_v4_rows_and_leaves_the_v6_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    new_v4_body = feed_body(('{"cidr":"5.188.0.0/16","sblid":"SBL111111","rir":"ripencc"}',), timestamp=1793600000)
    server = default_server(**{"/drop/drop_v4.json": new_v4_body})

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=NOW + timedelta(hours=2), transport=server.transport)

    assert feed_outcomes[0].status == "imported"
    assert await fetch_cidrs(pg_session_maker) == {"5.188.0.0/16", "2001:678:254::/48"}
    assert (await fetch_state(pg_session_maker, "v4")).record_count == 1


async def test_a_new_v6_body_leaves_the_v4_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    new_v6_body = feed_body(('{"cidr":"2a00:1::/32","sblid":"SBL222222","rir":"ripencc"}',), timestamp=1793600000)
    server = default_server(**{"/drop/drop_v6.json": new_v6_body})

    await refresh_drop_lists(pg_session_maker, now=NOW + timedelta(hours=2), transport=server.transport)

    assert await fetch_cidrs(pg_session_maker) == {"1.10.16.0/20", "45.148.10.0/24", "2a00:1::/32"}


async def test_an_html_body_fails_the_feed_and_keeps_the_old_rows(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server(**{"/drop/drop_v4.json": b"<html><body>Blocked</body></html>"})
    later = NOW + timedelta(hours=2)

    feed_outcomes = await refresh_drop_lists(pg_session_maker, now=later, transport=server.transport)

    assert [outcome.status for outcome in feed_outcomes] == ["failed", "unchanged", "unchanged"]
    assert feed_outcomes[0].reason == "invalid line 1"
    assert await fetch_cidrs(pg_session_maker) == {"1.10.16.0/20", "45.148.10.0/24", "2001:678:254::/48"}
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
        ("failed", "ValueError"),
        ("imported", None),
    ]
    assert (await fetch_state(pg_session_maker, "v6")).last_error == "ValueError"


async def test_startup_skips_a_feed_fetched_within_the_refresh_interval(pg_session_maker, clean_tables):
    await refresh_drop_lists(pg_session_maker, now=NOW, transport=default_server().transport)
    server = default_server()

    feed_outcomes = await refresh_drop_lists(
        pg_session_maker, now=NOW + timedelta(hours=1), startup=True, transport=server.transport
    )

    assert server.requested_paths == []
    assert {(outcome.status, outcome.reason) for outcome in feed_outcomes} == {("skipped", "fresh")}
