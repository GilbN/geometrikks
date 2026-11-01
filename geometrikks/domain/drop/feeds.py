"""Download and parse the Spamhaus DROP feeds (newline-delimited JSON).

Parsing is all or nothing: the first bad line, a missing metadata line or a
record count that disagrees with the metadata rejects the whole feed, so a
block page or a truncated download never replaces good rows.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Literal

import httpx2
import msgspec

from geometrikks.lib.outbound import USER_AGENT

if TYPE_CHECKING:
    from collections.abc import Callable

DropFeed = Literal["v4", "v6", "asn"]

FEED_URLS: dict[DropFeed, str] = {
    "v4": "https://www.spamhaus.org/drop/drop_v4.json",
    "v6": "https://www.spamhaus.org/drop/drop_v6.json",
    "asn": "https://www.spamhaus.org/drop/asndrop.json",
}

REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_ASN = 2**32 - 1


class DropFeedError(Exception):
    """A failed download or a rejected feed. str(error) is the reason stored in last_error."""


@dataclass(frozen=True)
class FeedMetadata:
    timestamp: datetime
    records: int
    copyright: str


@dataclass(frozen=True)
class NetworkRecord:
    cidr: str
    sbl_id: str
    rir: str | None


@dataclass(frozen=True)
class AsnRecord:
    asn: int
    name: str | None
    country_code: str | None
    rir: str | None
    domain: str | None


class LineKind(msgspec.Struct):
    type: str | None = None


class MetadataLine(msgspec.Struct):
    timestamp: int
    records: int
    copyright: str = ""


class NetworkLine(msgspec.Struct):
    cidr: str
    sblid: Annotated[str, msgspec.Meta(min_length=1)]
    rir: str | None = None


class AsnLine(msgspec.Struct):
    asn: Annotated[int, msgspec.Meta(ge=1, le=MAX_ASN)]
    rir: str | None = None
    domain: str | None = None
    cc: str | None = None
    asname: str | None = None


def _parse_feed[RecordT, LineT: msgspec.Struct](
    body: bytes,
    line_type: type[LineT],
    build_record: Callable[[LineT], RecordT],
    record_key: Callable[[RecordT], object],
) -> tuple[list[RecordT], FeedMetadata]:
    if not body.strip():
        raise DropFeedError("empty feed")
    records: list[RecordT] = []
    seen_keys: set[object] = set()
    metadata_line: MetadataLine | None = None
    line_count = 0

    for line_number, raw_line in enumerate(body.split(b"\n"), start=1):
        if not raw_line.strip():
            continue
        try:
            line_kind = msgspec.json.decode(raw_line, type=LineKind).type
            if line_kind is None:
                record = build_record(msgspec.json.decode(raw_line, type=line_type))
            elif line_kind == "metadata":
                if metadata_line is not None:
                    raise DropFeedError("more than one metadata line")
                metadata_line = msgspec.json.decode(raw_line, type=MetadataLine)
                # fromtimestamp raises for values beyond the platform's range
                datetime.fromtimestamp(metadata_line.timestamp, UTC)
                continue
            else:
                raise ValueError("unknown line type")
        except (msgspec.DecodeError, ValueError, OverflowError, OSError) as error:
            raise DropFeedError(f"invalid line {line_number}") from error
        line_count += 1
        key = record_key(record)
        # normalising can fold two lines onto one primary key
        if key not in seen_keys:
            seen_keys.add(key)
            records.append(record)

    if metadata_line is None:
        raise DropFeedError("missing metadata")
    if line_count == 0:
        raise DropFeedError("no records")
    if metadata_line.records != line_count:
        raise DropFeedError("record count mismatch")
    return records, FeedMetadata(
        timestamp=datetime.fromtimestamp(metadata_line.timestamp, UTC),
        records=metadata_line.records,
        copyright=metadata_line.copyright,
    )


def parse_network_feed(
    body: bytes, feed: Literal["v4", "v6"]
) -> tuple[list[NetworkRecord], FeedMetadata]:
    expected_version = 4 if feed == "v4" else 6
    wrong_family_reason = f"IPv{6 if feed == 'v4' else 4} network in the {feed} feed"

    def build_record(network_line: NetworkLine) -> NetworkRecord:
        network = ipaddress.ip_network(network_line.cidr, strict=False)
        if network.version != expected_version:
            raise DropFeedError(wrong_family_reason)
        return NetworkRecord(cidr=str(network), sbl_id=network_line.sblid, rir=network_line.rir)

    return _parse_feed(body, NetworkLine, build_record, lambda network_record: network_record.cidr)


def parse_asn_feed(body: bytes) -> tuple[list[AsnRecord], FeedMetadata]:
    def build_record(asn_line: AsnLine) -> AsnRecord:
        return AsnRecord(
            asn=asn_line.asn,
            name=asn_line.asname,
            country_code=asn_line.cc,
            rir=asn_line.rir,
            domain=asn_line.domain,
        )

    return _parse_feed(body, AsnLine, build_record, lambda asn_record: asn_record.asn)


async def fetch_feed(
    feed: DropFeed, *, transport: httpx2.AsyncBaseTransport | None = None
) -> bytes:
    """GET one feed, refusing anything but a 200 and anything over the size cap."""
    body = bytearray()
    try:
        async with (
            httpx2.AsyncClient(
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=True,
                headers={"User-Agent": USER_AGENT},
                transport=transport,
            ) as client,
            client.stream("GET", FEED_URLS[feed]) as response,
        ):
            if response.status_code != 200:
                raise DropFeedError(f"HTTP {response.status_code}")
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > MAX_RESPONSE_BYTES:
                    raise DropFeedError("response too large")
    except httpx2.TimeoutException as error:
        raise DropFeedError("timeout") from error
    except httpx2.HTTPError as error:
        raise DropFeedError(type(error).__name__) from error
    return bytes(body)
