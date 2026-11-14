"""The AbuseIPDB blacklist against Postgres: schema, the refresh rules and the read rules."""
from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx2
import msgspec
import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from litestar.testing import AsyncTestClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from structlog.testing import capture_logs

from geometrikks.config.settings import AbuseIpdbSettings, Settings
from geometrikks.domain.abuseipdb import blacklist as blacklist_module
from geometrikks.domain.abuseipdb import blacklist_file as blacklist_file_module
from geometrikks.domain.abuseipdb.blacklist import current_blacklist, refresh_blacklist, refresh_blacklist_file
from geometrikks.domain.abuseipdb.models import AbuseIpdbBlacklistEntry, AbuseIpdbBlacklistStatus
from geometrikks.domain.abuseipdb.repositories import AbuseIpdbBlacklistRepository
from geometrikks.server.core import create_app
from geometrikks.services.abuseipdb import AbuseIpdbClient, BlacklistResult
from tests.integration.test_drop_snapshot_pg import build_settings

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
GENERATED_AT = datetime(2026, 11, 8, 6, 0, tzinfo=UTC)
BLACKLIST_TABLES = ("abuseipdb_blacklist", "abuseipdb_blacklist_status")
BLACKLIST_ANSWER = {
    "meta": {"generatedAt": "2026-11-08T06:00:00+00:00"},
    "data": [
        {"ipAddress": "3.5.140.2", "abuseConfidenceScore": 100, "lastReportedAt": "2026-11-08T05:00:00+00:00"},
        {"ipAddress": "2600:1f18::1", "abuseConfidenceScore": 100, "lastReportedAt": "2026-11-08T05:00:00+00:00"},
    ],
}

Handler = Callable[[httpx2.Request], Any]


def blacklist_client(handler: Handler) -> tuple[AbuseIpdbClient, list[httpx2.Request]]:
    calls: list[httpx2.Request] = []

    async def recording(request: httpx2.Request) -> httpx2.Response:
        calls.append(request)
        response = handler(request)
        return await response if not isinstance(response, httpx2.Response) else response

    return AbuseIpdbClient(api_key="test-key", timeout=5, transport=httpx2.MockTransport(recording)), calls


def answer(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(200, json=BLACKLIST_ANSWER)


def rate_limited(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(
        429, json={"errors": [{"detail": "Daily rate limit of 5 requests exceeded", "status": 429}]}
    )


def empty_list(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(200, json={"meta": BLACKLIST_ANSWER["meta"], "data": []})


def not_json(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(200, content=b"<html>")


async def store_list(
    pg_session_maker,
    ips: list[str],
    *,
    generated_at: datetime = GENERATED_AT,
    refreshed_at: datetime = NOW,
    last_attempt_at: datetime | None = None,
) -> None:
    async with pg_session_maker() as session, session.begin():
        session.add_all(AbuseIpdbBlacklistEntry(ip_address=ip) for ip in ips)
        session.add(
            AbuseIpdbBlacklistStatus(
                id=1, generated_at=generated_at, refreshed_at=refreshed_at, last_attempt_at=last_attempt_at or refreshed_at
            )
        )


async def fetch_ips(pg_session_maker) -> set[str]:
    async with pg_session_maker() as session:
        repository = AbuseIpdbBlacklistRepository(session=session, wrap_exceptions=False)
        return set(await repository.ips())


async def fetch_status(pg_session_maker) -> AbuseIpdbBlacklistStatus | None:
    async with pg_session_maker() as session:
        return (await session.execute(select(AbuseIpdbBlacklistStatus))).scalar_one_or_none()


def _only_blacklist_tables(schema_object, name, type_, reflected, compare_to) -> bool:
    if type_ == "table":
        return name in BLACKLIST_TABLES
    return schema_object.table.name in BLACKLIST_TABLES


async def test_migrated_tables_match_the_models(pg_engine):
    async with pg_engine.connect() as connection:
        schema_diffs = await connection.run_sync(
            lambda sync_connection: compare_metadata(
                MigrationContext.configure(
                    sync_connection, opts={"compare_type": True, "include_object": _only_blacklist_tables}
                ),
                AbuseIpdbBlacklistEntry.metadata,
            )
        )

    assert schema_diffs == []


async def test_the_status_table_holds_one_row(pg_session_maker, clean_abuseipdb_blacklist):
    async with pg_session_maker() as session:
        session.add(AbuseIpdbBlacklistStatus(id=2))
        with pytest.raises(IntegrityError, match="ck_abuseipdb_blacklist_status_single_row"):
            await session.commit()


async def test_refresh_stores_the_list_and_its_times(pg_session_maker, clean_abuseipdb_blacklist):
    client, calls = blacklist_client(answer)

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist(pg_session_maker, client, now=NOW)

    assert outcome.status == "refreshed" and outcome.count == 2
    assert len(calls) == 1
    assert await fetch_ips(pg_session_maker) == {"3.5.140.2", "2600:1f18::1"}
    status = await fetch_status(pg_session_maker)
    assert status is not None
    assert (status.generated_at, status.refreshed_at, status.last_attempt_at) == (GENERATED_AT, NOW, NOW)
    refreshed_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_refreshed"]
    assert len(refreshed_logs) == 1 and refreshed_logs[0]["count"] == 2


async def test_refresh_replaces_the_previous_list(pg_session_maker, clean_abuseipdb_blacklist):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=24))
    client, _ = blacklist_client(answer)

    await refresh_blacklist(pg_session_maker, client, now=NOW)

    assert await fetch_ips(pg_session_maker) == {"3.5.140.2", "2600:1f18::1"}


async def test_the_attempt_is_committed_before_the_call(pg_session_maker, clean_abuseipdb_blacklist):
    attempts_seen: list[datetime | None] = []

    async def observing(request: httpx2.Request) -> httpx2.Response:
        status = await fetch_status(pg_session_maker)
        attempts_seen.append(status.last_attempt_at if status else None)
        return answer(request)

    client, _ = blacklist_client(observing)

    await refresh_blacklist(pg_session_maker, client, now=NOW)

    assert attempts_seen == [NOW]


@pytest.mark.parametrize(
    ("since_last_attempt", "fetched"),
    [(timedelta(hours=4, minutes=59), False), (timedelta(hours=5), True)],
    ids=["inside-the-window", "at-the-boundary"],
)
async def test_never_fetches_within_five_hours_of_the_last_attempt(
    pg_session_maker, clean_abuseipdb_blacklist, since_last_attempt, fetched
):
    await store_list(pg_session_maker, ["3.5.140.9"], last_attempt_at=NOW - since_last_attempt)
    client, calls = blacklist_client(answer)

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist(pg_session_maker, client, now=NOW, refresh_hours=6)

    assert bool(calls) is fetched
    assert outcome.status == ("refreshed" if fetched else "skipped")
    if not fetched:
        assert [entry["event"] for entry in captured_logs] == ["abuseipdb_blacklist_refresh_skipped"]


@pytest.mark.parametrize(
    "last_attempt_at",
    [None, NOW - timedelta(hours=6)],
    ids=["no-status-row", "old-status-row"],
)
async def test_concurrent_claims_let_exactly_one_through(
    pg_session_maker, clean_abuseipdb_blacklist, last_attempt_at
):
    if last_attempt_at is not None:
        await store_list(pg_session_maker, ["3.5.140.9"], last_attempt_at=last_attempt_at)

    both_in_a_transaction = asyncio.Barrier(2)

    async def claim() -> bool:
        async with pg_session_maker() as session, session.begin():
            # A claim is faster than opening a connection, so without this wait the two never overlap.
            await session.execute(text("SELECT 1"))
            await both_in_a_transaction.wait()
            repository = AbuseIpdbBlacklistRepository(session=session, wrap_exceptions=False)
            return await repository.claim_attempt(NOW, last_allowed=NOW - timedelta(hours=5))

    claims = await asyncio.gather(claim(), claim())

    assert sorted(claims) == [False, True]


async def test_a_failed_attempt_also_starts_the_five_hour_wait(pg_session_maker, clean_abuseipdb_blacklist):
    failing_client, _ = blacklist_client(rate_limited)
    await refresh_blacklist(pg_session_maker, failing_client, now=NOW)
    restarted_client, calls = blacklist_client(answer)

    outcome = await refresh_blacklist(pg_session_maker, restarted_client, now=NOW + timedelta(hours=4), startup=True)

    assert outcome.status == "skipped"
    assert calls == []


async def test_startup_skips_a_list_refreshed_within_the_interval(pg_session_maker, clean_abuseipdb_blacklist):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=23))
    client, calls = blacklist_client(answer)

    outcome = await refresh_blacklist(pg_session_maker, client, now=NOW, startup=True, refresh_hours=24)

    assert outcome.status == "skipped" and outcome.reason == "fresh"
    assert calls == []


async def test_startup_fetches_a_fresh_copy_of_an_old_list(pg_session_maker, clean_abuseipdb_blacklist):
    await store_list(
        pg_session_maker,
        ["3.5.140.9"],
        generated_at=NOW - timedelta(hours=80),
        refreshed_at=NOW - timedelta(hours=1),
        last_attempt_at=NOW - timedelta(hours=6),
    )
    client, calls = blacklist_client(answer)

    outcome = await refresh_blacklist(pg_session_maker, client, now=NOW, startup=True, refresh_hours=24)

    assert outcome.status == "refreshed"
    assert len(calls) == 1


async def test_startup_fetches_a_list_older_than_the_interval(pg_session_maker, clean_abuseipdb_blacklist):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=25))
    client, calls = blacklist_client(answer)

    outcome = await refresh_blacklist(pg_session_maker, client, now=NOW, startup=True, refresh_hours=24)

    assert outcome.status == "refreshed"
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("handler", "upstream_status", "reason"),
    [
        (rate_limited, 429, "Daily rate limit of 5 requests exceeded"),
        (empty_list, None, "AbuseIPDB sent an empty blacklist"),
        (not_json, None, "AbuseIPDB sent an unreadable answer"),
    ],
    ids=["rate-limited", "empty-list", "not-json"],
)
async def test_a_failed_download_keeps_the_previous_list(
    pg_session_maker, clean_abuseipdb_blacklist, handler, upstream_status, reason
):
    earlier = NOW - timedelta(hours=24)
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=earlier)
    client, _ = blacklist_client(handler)

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist(pg_session_maker, client, now=NOW)

    assert outcome.status == "failed"
    assert await fetch_ips(pg_session_maker) == {"3.5.140.9"}
    status = await fetch_status(pg_session_maker)
    assert status is not None
    assert (status.generated_at, status.refreshed_at, status.last_attempt_at) == (GENERATED_AT, earlier, NOW)
    failed_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_refresh_failed"]
    assert len(failed_logs) == 1
    assert failed_logs[0]["upstream_status"] == upstream_status
    assert failed_logs[0]["reason"] == reason


async def test_a_failed_write_keeps_the_list_and_the_status_together(pg_session_maker, clean_abuseipdb_blacklist):
    earlier = NOW - timedelta(hours=24)
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=earlier)

    class UnstorableClient:
        async def blacklist(self) -> BlacklistResult:
            return BlacklistResult(generated_at=NOW, ips=["3.5.140.2", "not-an-inet"])

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist(pg_session_maker, cast(AbuseIpdbClient, UnstorableClient()), now=NOW)

    assert outcome.status == "failed"
    assert await fetch_ips(pg_session_maker) == {"3.5.140.9"}
    status = await fetch_status(pg_session_maker)
    assert status is not None and status.refreshed_at == earlier
    failed_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_refresh_failed"]
    assert failed_logs[0]["upstream_status"] is None
    assert "3.5.140.2" not in failed_logs[0]["reason"]


def write_blacklist_file(path: Path, body: bytes, *, modified_at: datetime, extra_ns: int = 0) -> Path:
    path.write_bytes(body)
    modified_ns = int(modified_at.timestamp()) * 1_000_000_000 + extra_ns
    os.utime(path, ns=(modified_ns, modified_ns))
    return path


FILE_MODIFIED_AT = NOW - timedelta(hours=1)


async def test_file_refresh_stores_the_list_with_the_file_times(
    pg_session_maker, clean_abuseipdb_blacklist, tmp_path
):
    path = write_blacklist_file(
        tmp_path / "blacklist.json", msgspec.json.encode(BLACKLIST_ANSWER), modified_at=FILE_MODIFIED_AT
    )

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert outcome.status == "refreshed" and outcome.count == 2
    assert await fetch_ips(pg_session_maker) == {"3.5.140.2", "2600:1f18::1"}
    status = await fetch_status(pg_session_maker)
    assert status is not None
    assert (status.generated_at, status.refreshed_at, status.last_attempt_at) == (GENERATED_AT, FILE_MODIFIED_AT, None)
    refreshed_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_refreshed"]
    assert len(refreshed_logs) == 1
    assert (refreshed_logs[0]["count"], refreshed_logs[0]["path"]) == (2, str(path))


async def test_file_refresh_skips_a_file_modified_at_the_same_time(
    pg_session_maker, clean_abuseipdb_blacklist, tmp_path
):
    sub_second = 123_456_789
    path = write_blacklist_file(
        tmp_path / "blacklist.txt", b"3.5.140.2\n", modified_at=FILE_MODIFIED_AT, extra_ns=sub_second
    )
    assert (await refresh_blacklist_file(pg_session_maker, path, now=NOW)).status == "refreshed"
    write_blacklist_file(path, b"3.5.140.9\n", modified_at=FILE_MODIFIED_AT, extra_ns=sub_second)

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW + timedelta(minutes=5))

    assert (outcome.status, outcome.reason) == ("skipped", "unchanged")
    assert await fetch_ips(pg_session_maker) == {"3.5.140.2"}
    assert captured_logs == []


async def test_file_refresh_reads_a_modified_file(pg_session_maker, clean_abuseipdb_blacklist, tmp_path):
    path = write_blacklist_file(tmp_path / "blacklist.txt", b"3.5.140.2\n", modified_at=FILE_MODIFIED_AT)
    await refresh_blacklist_file(pg_session_maker, path, now=NOW)
    later = FILE_MODIFIED_AT + timedelta(minutes=30)
    write_blacklist_file(path, b"3.5.140.9\n", modified_at=later)

    outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert outcome.status == "refreshed"
    assert await fetch_ips(pg_session_maker) == {"3.5.140.9"}
    status = await fetch_status(pg_session_maker)
    assert status is not None and (status.generated_at, status.refreshed_at) == (later, later)


async def test_file_refresh_stores_the_time_of_the_file_it_read(
    pg_session_maker, clean_abuseipdb_blacklist, tmp_path, monkeypatch
):
    path = write_blacklist_file(tmp_path / "blacklist.txt", b"3.5.140.2\n", modified_at=FILE_MODIFIED_AT)
    replaced_after_the_stat = AsyncMock(return_value=FILE_MODIFIED_AT - timedelta(hours=80))
    monkeypatch.setattr(blacklist_file_module, "blacklist_file_modified_at", replaced_after_the_stat)

    await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    status = await fetch_status(pg_session_maker)
    assert status is not None and status.refreshed_at == FILE_MODIFIED_AT


async def test_file_refresh_ignores_the_five_hour_wait(pg_session_maker, clean_abuseipdb_blacklist, tmp_path):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=2), last_attempt_at=NOW)
    path = write_blacklist_file(tmp_path / "blacklist.txt", b"3.5.140.2\n", modified_at=FILE_MODIFIED_AT)

    outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert outcome.status == "refreshed"
    assert await fetch_ips(pg_session_maker) == {"3.5.140.2"}


def _missing(directory: Path) -> Path:
    return directory / "missing.json"


def _a_directory(directory: Path) -> Path:
    return directory


def _api_error(directory: Path) -> Path:
    body = b'{"errors": [{"detail": "Authentication failed", "status": 401}]}'
    return write_blacklist_file(directory / "blacklist.json", body, modified_at=FILE_MODIFIED_AT)


def _only_private(directory: Path) -> Path:
    return write_blacklist_file(directory / "blacklist.txt", b"10.0.0.5\n", modified_at=FILE_MODIFIED_AT)


def _a_fifo(directory: Path) -> Path:
    fifo = directory / "blacklist.txt"
    os.mkfifo(fifo)
    return fifo


def _modified_in_the_future(directory: Path) -> Path:
    return write_blacklist_file(
        directory / "blacklist.txt", b"3.5.140.2\n", modified_at=NOW + timedelta(minutes=6)
    )


@pytest.mark.parametrize(
    ("make_file", "reason"),
    [
        (_missing, "the file does not exist"),
        (_a_directory, "the path is a directory"),
        pytest.param(
            _a_fifo,
            "the path is not a regular file",
            marks=pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs"),
        ),
        (_api_error, "the file is not AbuseIPDB's JSON blacklist"),
        (_only_private, "the file holds no public IPs"),
        (_modified_in_the_future, "the file was modified in the future"),
    ],
    ids=["missing", "directory", "fifo", "api-error", "only-private", "future"],
)
async def test_a_bad_file_keeps_the_previous_list(
    pg_session_maker, clean_abuseipdb_blacklist, tmp_path, make_file, reason
):
    earlier = NOW - timedelta(hours=24)
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=earlier)
    path = make_file(tmp_path)

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert (outcome.status, outcome.reason) == ("failed", reason)
    assert await fetch_ips(pg_session_maker) == {"3.5.140.9"}
    status = await fetch_status(pg_session_maker)
    assert status is not None and status.refreshed_at == earlier
    failed_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_refresh_failed"]
    assert len(failed_logs) == 1
    assert (failed_logs[0]["reason"], failed_logs[0]["path"]) == (reason, str(path))


async def test_a_file_above_the_size_cap_is_refused(
    pg_session_maker, clean_abuseipdb_blacklist, tmp_path, monkeypatch
):
    monkeypatch.setattr(blacklist_file_module, "MAX_FILE_BYTES", 1024 * 1024)
    path = write_blacklist_file(
        tmp_path / "blacklist.txt", b"3.5.140.2\n" * (1024 * 1024 // 10 + 1), modified_at=FILE_MODIFIED_AT
    )

    outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert (outcome.status, outcome.reason) == ("failed", "the file is larger than 1 MB")
    assert await fetch_ips(pg_session_maker) == set()


async def test_a_long_file_keeps_its_first_ips(pg_session_maker, clean_abuseipdb_blacklist, tmp_path, monkeypatch):
    monkeypatch.setattr(blacklist_file_module, "MAX_FILE_IPS", 2)
    path = write_blacklist_file(
        tmp_path / "blacklist.txt", b"3.5.140.2\n3.5.140.9\n3.5.140.12\n", modified_at=FILE_MODIFIED_AT
    )

    with capture_logs() as captured_logs:
        outcome = await refresh_blacklist_file(pg_session_maker, path, now=NOW)

    assert outcome.status == "refreshed" and outcome.count == 2
    assert await fetch_ips(pg_session_maker) == {"3.5.140.2", "3.5.140.9"}
    truncated_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_blacklist_file_truncated"]
    assert len(truncated_logs) == 1
    assert (truncated_logs[0]["count"], truncated_logs[0]["kept"]) == (3, 2)


async def read_view(pg_session_maker, *, enabled: bool, now: datetime):
    async with pg_session_maker() as session:
        repository = AbuseIpdbBlacklistRepository(session=session, wrap_exceptions=False)
        return await current_blacklist(repository, enabled=enabled, now=now)


@pytest.fixture()
def forget_logged_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(blacklist_module, "_expiry_logged_for", None)


async def test_the_read_path_is_empty_before_the_first_download(pg_session_maker, clean_abuseipdb_blacklist):
    view = await read_view(pg_session_maker, enabled=True, now=NOW)

    assert (view.generated_at, view.refreshed_at, view.ips) == (None, None, [])


async def test_a_list_72_hours_old_is_still_shown(pg_session_maker, clean_abuseipdb_blacklist, forget_logged_expiry):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=72))

    view = await read_view(pg_session_maker, enabled=True, now=NOW)

    assert view.ips == ["3.5.140.9"]
    assert view.refreshed_at == NOW - timedelta(hours=72)


async def test_an_expired_list_is_hidden_and_logged_once(
    pg_session_maker, clean_abuseipdb_blacklist, forget_logged_expiry
):
    refreshed_at = NOW - timedelta(hours=72, seconds=1)
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=refreshed_at)

    with capture_logs() as captured_logs:
        first_view = await read_view(pg_session_maker, enabled=True, now=NOW)
        second_view = await read_view(pg_session_maker, enabled=True, now=NOW)

    assert (first_view.generated_at, first_view.refreshed_at, first_view.ips) == (None, None, [])
    assert second_view.ips == []
    assert [entry["event"] for entry in captured_logs] == ["abuseipdb_blacklist_expired"]


async def test_a_list_generated_more_than_72_hours_ago_is_hidden(
    pg_session_maker, clean_abuseipdb_blacklist, forget_logged_expiry
):
    await store_list(
        pg_session_maker,
        ["3.5.140.9"],
        generated_at=NOW - timedelta(hours=72, seconds=1),
        refreshed_at=NOW - timedelta(hours=1),
    )

    with capture_logs() as captured_logs:
        view = await read_view(pg_session_maker, enabled=True, now=NOW)

    assert view.ips == []
    assert captured_logs[0]["generated_at"] == (NOW - timedelta(hours=72, seconds=1)).isoformat()


async def test_a_later_expiry_is_logged_again(pg_session_maker, clean_abuseipdb_blacklist, forget_logged_expiry):
    await store_list(pg_session_maker, ["3.5.140.9"], refreshed_at=NOW - timedelta(hours=80))
    with capture_logs() as first_expiry_logs:
        await read_view(pg_session_maker, enabled=True, now=NOW)
    async with pg_session_maker() as session, session.begin():
        await session.execute(text("UPDATE abuseipdb_blacklist_status SET refreshed_at = :at"), {"at": NOW})

    with capture_logs() as second_expiry_logs:
        await read_view(pg_session_maker, enabled=True, now=NOW + timedelta(hours=73))

    assert len(first_expiry_logs) == len(second_expiry_logs) == 1


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    settings = build_settings(migrated_database_url)
    return settings.model_copy(
        update={"abuseipdb": AbuseIpdbSettings(api_key="test-key", blacklist_enabled=True, _env_file=None)}
    )


async def test_the_route_returns_the_stored_list(pg_session_maker, clean_abuseipdb_blacklist, app_settings):
    refreshed_at = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    generated_at = refreshed_at - timedelta(hours=2)
    await store_list(
        pg_session_maker, ["3.5.140.2", "2600:1f18::1"], generated_at=generated_at, refreshed_at=refreshed_at
    )

    async with AsyncTestClient(create_app(settings=app_settings)) as http:
        blacklist_response = await http.get("/api/v1/abuseipdb/blacklist")
        status_response = await http.get("/api/v1/abuseipdb/status")

    assert blacklist_response.status_code == 200
    assert blacklist_response.json() == {
        "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
        "refreshedAt": refreshed_at.isoformat().replace("+00:00", "Z"),
        "ips": ["3.5.140.2", "2600:1f18::1"],
    }
    assert status_response.json()["blacklistEnabled"] is True


async def test_the_route_is_empty_with_the_feature_off(pg_session_maker, clean_abuseipdb_blacklist, app_settings):
    await store_list(pg_session_maker, ["3.5.140.2"], refreshed_at=datetime.now(UTC))
    feature_off = app_settings.model_copy(update={"abuseipdb": AbuseIpdbSettings(api_key="test-key", _env_file=None)})

    async with AsyncTestClient(create_app(settings=feature_off)) as http:
        blacklist_response = await http.get("/api/v1/abuseipdb/blacklist")
        status_response = await http.get("/api/v1/abuseipdb/status")

    assert blacklist_response.json() == {"generatedAt": None, "refreshedAt": None, "ips": []}
    assert status_response.json()["blacklistEnabled"] is False
