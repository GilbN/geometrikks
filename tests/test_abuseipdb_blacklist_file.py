"""Reading a blacklist file that something else downloads, in AbuseIPDB's JSON or plaintext format."""
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import msgspec
import pytest

from geometrikks.domain.abuseipdb.blacklist_file import (
    BlacklistFileError,
    parse_blacklist_file,
    read_blacklist_file,
)
from geometrikks.services.abuseipdb import BlacklistResult

MODIFIED_AT = datetime(2026, 11, 8, 7, 0, tzinfo=UTC)
GENERATED_AT = datetime(2026, 11, 8, 6, 0, tzinfo=UTC)


def json_file(*ip_addresses: str) -> bytes:
    return msgspec.json.encode(
        {
            "meta": {"generatedAt": "2026-11-08T06:00:00+00:00"},
            "data": [
                {"ipAddress": ip_address, "abuseConfidenceScore": 100, "lastReportedAt": "2026-11-08T05:00:00+00:00"}
                for ip_address in ip_addresses
            ],
        }
    )


def test_the_api_json_keeps_its_generation_time():
    result = parse_blacklist_file(json_file("3.5.140.2", "2600:1f18::1"), modified_at=MODIFIED_AT)

    assert result == BlacklistResult(generated_at=GENERATED_AT, ips=["3.5.140.2", "2600:1f18::1"])


def test_the_api_json_after_leading_whitespace():
    result = parse_blacklist_file(b"\n  " + json_file("3.5.140.2"), modified_at=MODIFIED_AT)

    assert result.ips == ["3.5.140.2"]


def test_the_api_json_after_a_byte_order_mark():
    result = parse_blacklist_file(b"\xef\xbb\xbf" + json_file("3.5.140.2"), modified_at=MODIFIED_AT)

    assert result.generated_at == GENERATED_AT and result.ips == ["3.5.140.2"]


def test_plaintext_after_a_byte_order_mark_keeps_its_first_ip():
    result = parse_blacklist_file(b"\xef\xbb\xbf3.5.140.2\r\n3.5.140.9\r\n", modified_at=MODIFIED_AT)

    assert result.ips == ["3.5.140.2", "3.5.140.9"]


def test_json_in_another_shape_is_refused():
    with pytest.raises(BlacklistFileError, match="not AbuseIPDB's JSON blacklist"):
        parse_blacklist_file(b'{"errors": [{"detail": "Authentication failed"}]}', modified_at=MODIFIED_AT)


def test_plaintext_takes_the_modification_time_as_its_generation_time():
    result = parse_blacklist_file(b"3.5.140.2\n2600:1f18::1\n", modified_at=MODIFIED_AT)

    assert result == BlacklistResult(generated_at=MODIFIED_AT, ips=["3.5.140.2", "2600:1f18::1"])


def test_plaintext_skips_comments_blanks_and_what_is_not_a_public_ip():
    body = (
        b"# AbuseIPDB blacklist\r\n"
        b"\r\n"
        b"  3.5.140.2  \r\n"
        b"3.5.140.9 # US AS16509\r\n"
        b"3.5.140.2\r\n"
        b"10.0.0.5\r\n"
        b"not-an-ip\r\n"
        b"2600:1F18:0::1\r\n"
        b"\xff\xfe\r\n"
    )

    result = parse_blacklist_file(body, modified_at=MODIFIED_AT)

    assert result.ips == ["3.5.140.2", "3.5.140.9", "2600:1f18::1"]


@pytest.mark.parametrize(
    "body", [b"", b"# nothing yet\n", b"10.0.0.5\n192.168.1.1\n", b'{"meta": {}, "data": []}'],
    ids=["empty", "only-comments", "only-private", "json-without-a-time"],
)
def test_a_file_without_public_ips_is_refused(body):
    with pytest.raises(BlacklistFileError):
        parse_blacklist_file(body, modified_at=MODIFIED_AT)


def test_an_empty_json_list_is_refused():
    with pytest.raises(BlacklistFileError, match="no public IPs"):
        parse_blacklist_file(json_file(), modified_at=MODIFIED_AT)


@pytest.mark.anyio
@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")
async def test_reading_a_fifo_fails_instead_of_waiting_for_a_writer(tmp_path):
    fifo = tmp_path / "blacklist.txt"
    os.mkfifo(fifo)

    with pytest.raises(BlacklistFileError, match="the path is not a regular file"):
        await read_blacklist_file(fifo, now=datetime.now(UTC))


@pytest.mark.anyio
async def test_the_read_returns_the_modification_time_of_the_file_it_read(tmp_path):
    path = tmp_path / "blacklist.txt"
    path.write_bytes(b"3.5.140.2\n")
    modified_ns = 1_762_585_200_123_456_789
    os.utime(path, ns=(modified_ns, modified_ns))

    modified_at, body = await read_blacklist_file(path, now=datetime(2026, 11, 8, 8, 0, tzinfo=UTC))

    assert body == b"3.5.140.2\n"
    assert modified_at == datetime(2025, 11, 8, 7, 0, tzinfo=UTC) + timedelta(microseconds=123_456)


@pytest.mark.anyio
@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="counts descriptors in /proc")
async def test_a_refused_path_leaves_no_descriptor_open(tmp_path):
    open_before = len(os.listdir("/proc/self/fd"))

    for _ in range(5):
        with pytest.raises(BlacklistFileError, match="the path is a directory"):
            await read_blacklist_file(tmp_path, now=datetime.now(UTC))

    assert len(os.listdir("/proc/self/fd")) <= open_before
