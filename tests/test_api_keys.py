"""API key material and the ApiKeyStore over an in-memory repository."""

from __future__ import annotations

import dataclasses
import hashlib
import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import sqlalchemy.exc
from litestar import Litestar
from litestar.exceptions import ServiceUnavailableException
from structlog.testing import capture_logs

from geometrikks.domain.auth.api_keys import (
    API_KEY_BODY_LENGTH,
    API_KEY_PREFIX,
    ApiKeyRecord,
    display_prefix_of,
    generate_api_key,
    hash_api_key,
    is_api_key_token,
    is_well_formed_api_key,
)
from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError, DomainValidationError
from geometrikks.server import runtime
from geometrikks.server.api_key_store import ApiKeyStore, install_api_key_store
from tests.api_key_support import MemoryApiKeyRepository

pytestmark = pytest.mark.anyio

START = datetime(2026, 11, 2, 10, 0, tzinfo=UTC)


class FakeClock:
    def __init__(self, now: datetime = START) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _store(
    clock: FakeClock | None = None, *, available: bool = True
) -> tuple[ApiKeyStore, MemoryApiKeyRepository, FakeClock]:
    store_clock = clock or FakeClock()
    repository = MemoryApiKeyRepository(clock=store_clock)
    store = ApiKeyStore(repository, is_available=lambda: available, clock=store_clock)
    return store, repository, store_clock


def _record(*, expires_at: datetime | None = None) -> ApiKeyRecord:
    return ApiKeyRecord(
        id=uuid4(),
        name="homepage",
        scope="read",
        display_prefix="gmk_7Hq2",
        created_at=START,
        created_by="admin",
        expires_at=expires_at,
        last_used_at=None,
        last_used_ip=None,
    )


def test_generated_key_has_prefix_length_and_base62_body() -> None:
    material = generate_api_key()

    assert re.fullmatch(r"gmk_[0-9A-Za-z]{43}", material.key)
    assert material.display_prefix == material.key[:8]
    assert material.key_hash == hashlib.sha256(material.key.encode()).hexdigest()
    assert hash_api_key(material.key) == material.key_hash
    assert is_well_formed_api_key(material.key)
    assert API_KEY_PREFIX == "gmk_"
    assert API_KEY_BODY_LENGTH == 43


def test_generated_keys_differ() -> None:
    assert len({generate_api_key().key for _ in range(200)}) == 200


@pytest.mark.parametrize(
    "token",
    [
        "gmk_",
        "gmk_" + "a" * 42,
        "gmk_" + "a" * 44,
        "gmk_" + "a" * 42 + "-",
        "gmk_" + "a" * 42 + "_",
        "GMK_" + "a" * 43,
        "abc_" + "a" * 43,
    ],
)
def test_well_formed_rejects_short_long_and_symbols(token: str) -> None:
    assert is_well_formed_api_key(token) is False


def test_api_key_token_is_decided_by_prefix_only() -> None:
    assert is_api_key_token("gmk_")
    assert is_api_key_token("gmk_not-base62")
    assert not is_api_key_token("eyJhbGciOiJIUzI1NiJ9.payload.sig")


def test_display_prefix_of_any_token_is_first_eight_characters() -> None:
    assert display_prefix_of("gmk_7Hq2abcdef") == "gmk_7Hq2"
    assert display_prefix_of("gmk_") == "gmk_"


def test_record_expiry_is_inclusive_of_now() -> None:
    assert _record(expires_at=None).is_expired(START) is False
    assert _record(expires_at=START + timedelta(seconds=1)).is_expired(START) is False
    assert _record(expires_at=START).is_expired(START) is True
    assert _record(expires_at=START - timedelta(seconds=1)).is_expired(START) is True


async def test_create_returns_the_key_once_and_stores_only_the_hash() -> None:
    store, repository, _ = _store()

    api_key_record, key = await store.create(
        name="  homepage  ", scope="read", expires_at=None, created_by="admin"
    )

    assert is_well_formed_api_key(key)
    assert api_key_record.name == "homepage"
    assert api_key_record.scope == "read"
    assert api_key_record.created_by == "admin"
    assert api_key_record.display_prefix == key[:8]
    assert list(repository.records_by_hash) == [hash_api_key(key)]
    stored_record = repository.records_by_hash[hash_api_key(key)]
    assert key not in dataclasses.asdict(stored_record).values()
    assert await store.authenticate(key) == api_key_record
    assert await store.list_records() == [api_key_record]


async def test_create_rejects_past_expiry() -> None:
    store, repository, clock = _store()

    with pytest.raises(DomainValidationError):
        await store.create(name="old", scope="read", expires_at=clock.now, created_by="admin")
    with pytest.raises(DomainValidationError):
        await store.create(
            name="older", scope="read", expires_at=clock.now - timedelta(days=1), created_by="admin"
        )
    assert repository.records_by_hash == {}


@pytest.mark.parametrize("name", ["", "   ", "x" * 65])
async def test_create_rejects_blank_or_overlong_names(name: str) -> None:
    store, repository, _ = _store()

    with pytest.raises(DomainValidationError):
        await store.create(name=name, scope="read", expires_at=None, created_by="admin")
    assert repository.records_by_hash == {}


async def test_duplicate_name_differing_in_case_conflicts() -> None:
    store, _, _ = _store()
    await store.create(name="Homepage", scope="read", expires_at=None, created_by="admin")

    with pytest.raises(DomainConflictError):
        await store.create(name="homepage", scope="read_write", expires_at=None, created_by="admin")


async def test_authenticate_returns_expired_records_and_none_for_unknown_keys() -> None:
    store, _, clock = _store()
    api_key_record, key = await store.create(
        name="short-lived", scope="read", expires_at=clock.now + timedelta(minutes=1), created_by="admin"
    )
    clock.advance(120)

    assert await store.authenticate(key) == api_key_record
    assert await store.authenticate(generate_api_key().key) is None


async def test_revoke_removes_the_key() -> None:
    store, _, _ = _store()
    api_key_record, key = await store.create(name="homepage", scope="read", expires_at=None, created_by="admin")

    assert await store.revoke(api_key_record.id) == api_key_record
    assert await store.authenticate(key) is None


async def test_revoke_unknown_id_is_not_found() -> None:
    store, _, _ = _store()

    with pytest.raises(DomainNotFoundError):
        await store.revoke(uuid4())


async def test_record_use_writes_at_most_once_a_minute_per_key_unless_ip_changes() -> None:
    store, repository, clock = _store()
    _, key = await store.create(name="homepage", scope="read", expires_at=None, created_by="admin")

    async def use_key(ip: str | None) -> None:
        api_key_record = await store.authenticate(key)
        assert api_key_record is not None
        await store.record_use(api_key_record, ip)

    await use_key("192.168.1.20")
    clock.advance(30)
    await use_key("192.168.1.20")
    clock.advance(30)
    await use_key("192.168.1.20")
    assert [touch[1:] for touch in repository.touches] == [(START, "192.168.1.20")]

    clock.advance(1)
    await use_key("192.168.1.20")
    clock.advance(1)
    await use_key("192.168.1.21")
    assert [touch[1:] for touch in repository.touches] == [
        (START, "192.168.1.20"),
        (START + timedelta(seconds=61), "192.168.1.20"),
        (START + timedelta(seconds=62), "192.168.1.21"),
    ]


@pytest.mark.parametrize(
    "touch_error",
    [
        sqlalchemy.exc.OperationalError("UPDATE api_keys", {}, Exception("connection reset")),
        sqlalchemy.exc.IntegrityError("UPDATE api_keys", {}, Exception("constraint")),
        RuntimeError("unexpected"),
    ],
)
async def test_record_use_swallows_repository_errors(touch_error: BaseException) -> None:
    store, repository, _ = _store()
    api_key_record, _ = await store.create(name="homepage", scope="read", expires_at=None, created_by="admin")
    repository.touch_error = touch_error

    with capture_logs() as captured_logs:
        await store.record_use(api_key_record, "192.168.1.20")

    assert [(log_entry["event"], log_entry["log_level"]) for log_entry in captured_logs] == [
        ("api_key_touch_failed", "warning")
    ]


async def test_record_use_swallows_an_unavailable_store() -> None:
    store, repository, _ = _store(available=False)

    with capture_logs() as captured_logs:
        await store.record_use(_record(), "192.168.1.20")

    assert repository.touches == []
    assert [(log_entry["event"], log_entry["log_level"]) for log_entry in captured_logs] == [
        ("api_key_touch_failed", "warning")
    ]


async def test_rejection_log_throttle_per_prefix_and_ip() -> None:
    store, _, clock = _store()

    assert store.should_log_rejection("gmk_7Hq2", "192.168.1.20") is True
    assert store.should_log_rejection("gmk_7Hq2", "192.168.1.20") is False
    assert store.should_log_rejection("gmk_7Hq2", "192.168.1.21") is True
    assert store.should_log_rejection("gmk_Ve8s", "192.168.1.20") is True
    assert store.should_log_rejection("gmk_Ve8s", None) is True
    assert store.should_log_rejection("gmk_Ve8s", None) is False

    clock.advance(59)
    assert store.should_log_rejection("gmk_7Hq2", "192.168.1.20") is False
    clock.advance(1)
    assert store.should_log_rejection("gmk_7Hq2", "192.168.1.20") is True


async def test_rejection_log_throttle_drops_entries_older_than_the_window() -> None:
    store, _, clock = _store()
    for host_number in range(100):
        store.should_log_rejection("gmk_7Hq2", f"10.0.0.{host_number}")
    clock.advance(61)

    store.should_log_rejection("gmk_Ve8s", "192.168.1.20")

    assert len(store._rejections_logged_at) == 1


async def test_unavailable_store_raises_503() -> None:
    store, _, _ = _store(available=False)

    with pytest.raises(ServiceUnavailableException):
        await store.authenticate(generate_api_key().key)
    with pytest.raises(ServiceUnavailableException):
        await store.list_records()
    with pytest.raises(ServiceUnavailableException):
        await store.create(name="homepage", scope="read", expires_at=None, created_by="admin")
    with pytest.raises(ServiceUnavailableException):
        await store.revoke(uuid4())


async def test_database_outage_raises_503() -> None:
    store, repository, _ = _store()
    repository.find_error = sqlalchemy.exc.OperationalError("SELECT", {}, Exception("connection refused"))

    with pytest.raises(ServiceUnavailableException):
        await store.authenticate(generate_api_key().key)


async def test_install_puts_the_store_on_app_state_and_follows_session_store_readiness() -> None:
    app = Litestar()

    store = install_api_key_store(app, MemoryApiKeyRepository())

    assert runtime.get_api_key_store(app) is store
    assert store.is_available() is True
    app.state.session_store_ready = False
    with pytest.raises(ServiceUnavailableException):
        await store.list_records()
