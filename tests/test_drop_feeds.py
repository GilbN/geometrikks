"""DROP feed parsing and download: strict, so a bad body never reaches the tables."""
import asyncio
from datetime import UTC, datetime

import httpx2
import pytest

from geometrikks.domain.drop.feeds import (
    FEED_URLS,
    MAX_RESPONSE_BYTES,
    AsnRecord,
    DropFeedError,
    FeedMetadata,
    NetworkRecord,
    fetch_feed,
    parse_asn_feed,
    parse_network_feed,
)
from geometrikks.lib.outbound import USER_AGENT

pytestmark = pytest.mark.anyio

V4_LINE = '{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}'
V6_LINE = '{"cidr":"2001:678:254::/48","sblid":"SBL697648","rir":"ripencc"}'
ASN_LINE = '{"asn":48090,"rir":"ripencc","domain":"techoff.example","cc":"NL","asname":"TECHOFF"}'
COPYRIGHT = "(c) 2026 The Spamhaus Project SLU"


def metadata_line(records: int, *, timestamp: int = 1793535242) -> str:
    return (
        f'{{"type":"metadata","timestamp":{timestamp},"size":107020,"records":{records},'
        f'"copyright":"{COPYRIGHT}","terms":"https://www.spamhaus.org/drop/terms/"}}'
    )


def feed_body(*lines: str) -> bytes:
    return ("\n".join(lines) + "\n").encode()


def test_network_feed_parses_the_v4_sample_line() -> None:
    network_records, _ = parse_network_feed(feed_body(V4_LINE, metadata_line(1)), "v4")
    assert network_records == [NetworkRecord(cidr="1.10.16.0/20", sbl_id="SBL256894", rir="apnic")]


def test_network_feed_parses_the_v6_sample_line() -> None:
    network_records, _ = parse_network_feed(feed_body(V6_LINE, metadata_line(1)), "v6")
    assert network_records == [
        NetworkRecord(cidr="2001:678:254::/48", sbl_id="SBL697648", rir="ripencc")
    ]


def test_asn_feed_parses_the_sample_line() -> None:
    asn_records, _ = parse_asn_feed(feed_body(ASN_LINE, metadata_line(1)))
    assert asn_records == [
        AsnRecord(
            asn=48090, name="TECHOFF", country_code="NL", rir="ripencc", domain="techoff.example"
        )
    ]


def test_asn_feed_keeps_absent_optional_fields_as_none() -> None:
    asn_records, _ = parse_asn_feed(feed_body('{"asn":64500}', metadata_line(1)))
    assert asn_records == [
        AsnRecord(asn=64500, name=None, country_code=None, rir=None, domain=None)
    ]


def test_metadata_becomes_an_aware_utc_datetime() -> None:
    _, feed_metadata = parse_network_feed(feed_body(V4_LINE, metadata_line(1)), "v4")
    assert feed_metadata == FeedMetadata(
        timestamp=datetime.fromtimestamp(1793535242, UTC), records=1, copyright=COPYRIGHT
    )
    assert feed_metadata.timestamp.utcoffset() is not None


def test_metadata_line_may_come_first() -> None:
    network_records, feed_metadata = parse_network_feed(
        feed_body(metadata_line(2), V4_LINE, '{"cidr":"5.8.10.0/24","sblid":"SBL1"}'), "v4"
    )
    assert [network_record.cidr for network_record in network_records] == [
        "1.10.16.0/20",
        "5.8.10.0/24",
    ]
    assert feed_metadata.records == 2


def test_blank_lines_are_skipped() -> None:
    network_records, _ = parse_network_feed(
        b"\n" + feed_body(V4_LINE, "", metadata_line(1)) + b"\n\n", "v4"
    )
    assert len(network_records) == 1


def test_non_canonical_cidr_is_normalised_to_its_network() -> None:
    network_records, _ = parse_network_feed(
        feed_body('{"cidr":"1.10.16.5/20","sblid":"SBL256894"}', metadata_line(1)), "v4"
    )
    assert network_records[0].cidr == "1.10.16.0/20"


def test_duplicate_networks_keep_the_first_line() -> None:
    network_records, _ = parse_network_feed(
        feed_body(
            '{"cidr":"1.10.16.0/20","sblid":"SBL1"}',
            '{"cidr":"1.10.16.5/20","sblid":"SBL2"}',
            metadata_line(2),
        ),
        "v4",
    )
    assert network_records == [NetworkRecord(cidr="1.10.16.0/20", sbl_id="SBL1", rir=None)]


def test_duplicate_asns_keep_the_first_line() -> None:
    asn_records, _ = parse_asn_feed(
        feed_body('{"asn":1,"asname":"ONE"}', '{"asn":1,"asname":"TWO"}', metadata_line(2))
    )
    assert [asn_record.name for asn_record in asn_records] == ["ONE"]


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (feed_body(V4_LINE), "missing metadata"),
        (feed_body(V4_LINE, metadata_line(1), metadata_line(1)), "more than one metadata line"),
        (feed_body(V4_LINE, metadata_line(2)), "record count mismatch"),
        (feed_body(metadata_line(0)), "no records"),
        (b"", "empty feed"),
        (feed_body(V4_LINE, '{"type":"other"}', metadata_line(1)), "invalid line 2"),
        (b"<html><body>Blocked</body></html>", "invalid line 1"),
        (feed_body(V4_LINE, "not json", metadata_line(2)), "invalid line 2"),
        (b"\xff\xfe" + feed_body(V4_LINE, metadata_line(1)), "invalid encoding"),
        (feed_body('{"cidr":"1.10.16.0/33","sblid":"SBL1"}', metadata_line(1)), "invalid line 1"),
        (feed_body('{"cidr":"2001:678:254::%eth0/48","sblid":"SBL1"}', metadata_line(1)), "invalid line 1"),
        (feed_body('{"cidr":"not-a-cidr","sblid":"SBL1"}', metadata_line(1)), "invalid line 1"),
        (feed_body('{"cidr":"1.10.16.0/20"}', metadata_line(1)), "invalid line 1"),
        (feed_body('{"cidr":"1.10.16.0/20","sblid":""}', metadata_line(1)), "invalid line 1"),
        (feed_body(V6_LINE, metadata_line(1)), "IPv6 network in the v4 feed"),
        (
            feed_body(V4_LINE, metadata_line(1, timestamp=10**15)),
            "invalid line 2",
        ),
    ],
)
def test_bad_v4_bodies_are_rejected(body: bytes, reason: str) -> None:
    with pytest.raises(DropFeedError) as raised_error:
        parse_network_feed(body, "v4")
    assert str(raised_error.value) == reason


def test_ipv4_network_in_the_v6_feed_is_rejected() -> None:
    with pytest.raises(DropFeedError) as raised_error:
        parse_network_feed(feed_body(V4_LINE, metadata_line(1)), "v6")
    assert str(raised_error.value) == "IPv4 network in the v6 feed"


@pytest.mark.parametrize(
    "body",
    [
        feed_body(ASN_LINE),
        feed_body(ASN_LINE, metadata_line(5)),
        feed_body(metadata_line(0)),
        b"<html></html>",
        feed_body('{"asn":0}', metadata_line(1)),
        feed_body('{"asn":4294967296}', metadata_line(1)),
        feed_body('{"asn":"48090"}', metadata_line(1)),
        feed_body(V4_LINE, metadata_line(1)),
    ],
)
def test_bad_asn_bodies_are_rejected(body: bytes) -> None:
    with pytest.raises(DropFeedError):
        parse_asn_feed(body)


def feed_transport(handler) -> httpx2.MockTransport:
    return httpx2.MockTransport(handler)


async def test_fetch_feed_returns_the_body_and_identifies_itself() -> None:
    requests: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(200, content=b"feed body")

    body = await fetch_feed("v4", transport=feed_transport(handler))

    assert body == b"feed body"
    assert str(requests[0].url) == "https://www.spamhaus.org/drop/drop_v4.json"
    assert requests[0].headers["user-agent"] == USER_AGENT


def test_feed_urls_name_all_three_feeds() -> None:
    assert FEED_URLS == {
        "v4": "https://www.spamhaus.org/drop/drop_v4.json",
        "v6": "https://www.spamhaus.org/drop/drop_v6.json",
        "asn": "https://www.spamhaus.org/drop/asndrop.json",
    }


async def test_fetch_feed_follows_redirects() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/drop/asndrop.json":
            return httpx2.Response(301, headers={"Location": "https://www.spamhaus.org/moved.json"})
        return httpx2.Response(200, content=b"moved body")

    assert await fetch_feed("asn", transport=feed_transport(handler)) == b"moved body"


async def test_fetch_feed_rejects_a_non_200_status() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(503)

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "HTTP 503"


async def test_fetch_feed_rejects_a_body_over_the_cap() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1))

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "response too large"


async def test_fetch_feed_accepts_a_body_at_the_cap() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=b"x" * MAX_RESPONSE_BYTES)

    assert len(await fetch_feed("v4", transport=feed_transport(handler))) == MAX_RESPONSE_BYTES


async def test_fetch_feed_names_a_timeout() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow", request=request)

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "timeout"


async def test_fetch_feed_names_a_connection_failure() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "ConnectError"


def test_deeply_nested_unknown_field_is_rejected_not_a_recursion_error() -> None:
    nested = "[" * 20_000 + "]" * 20_000
    line = f'{{"cidr":"1.10.16.0/20","sblid":"SBL1","extra":{nested}}}'
    with pytest.raises(DropFeedError) as raised_error:
        parse_network_feed(feed_body(line, metadata_line(1)), "v4")
    assert str(raised_error.value) == "invalid line 1"
    asn_line = f'{{"asn":1,"extra":{nested}}}'
    with pytest.raises(DropFeedError):
        parse_asn_feed(feed_body(asn_line, metadata_line(1)))


def test_invalid_utf8_in_an_ignored_field_is_rejected() -> None:
    line = b'{"cidr":"1.10.16.0/20","sblid":"SBL1","note":"\xff"}'
    with pytest.raises(DropFeedError) as raised_error:
        parse_network_feed(line + b"\n" + metadata_line(1).encode(), "v4")
    assert str(raised_error.value) == "invalid encoding"


async def test_fetch_feed_follows_a_redirect_without_reading_its_body() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/drop/drop_v4.json":
            return httpx2.Response(
                302,
                headers={"Location": "/moved.json"},
                content=b"x" * (MAX_RESPONSE_BYTES + 1),
            )
        return httpx2.Response(200, content=b"moved body")

    assert await fetch_feed("v4", transport=feed_transport(handler)) == b"moved body"


async def test_fetch_feed_rejects_a_redirect_to_a_non_https_url() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(302, headers={"Location": "http://www.spamhaus.org/moved.json"})

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "redirect to a non-https URL"


async def test_fetch_feed_allows_three_redirects_and_rejects_a_fourth() -> None:
    requested_paths: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requested_paths.append(request.url.path)
        hop_count = len(requested_paths)
        if hop_count <= redirect_count:
            return httpx2.Response(302, headers={"Location": f"/hop{hop_count}"})
        return httpx2.Response(200, content=b"final")

    redirect_count = 3
    assert await fetch_feed("v4", transport=feed_transport(handler)) == b"final"

    requested_paths.clear()
    redirect_count = 4
    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "too many redirects"
    assert len(requested_paths) == 4


async def test_fetch_feed_rejects_a_redirect_without_a_location() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(302)

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "HTTP 302"


async def test_fetch_feed_gives_up_after_the_overall_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("geometrikks.domain.drop.feeds.FETCH_DEADLINE_SECONDS", 0.05)

    async def handler(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(5)
        return httpx2.Response(200, content=b"late")

    with pytest.raises(DropFeedError) as raised_error:
        await fetch_feed("v4", transport=feed_transport(handler))
    assert str(raised_error.value) == "timed out"
