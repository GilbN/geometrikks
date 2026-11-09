"""Postgres-backed API keys, with the same outage handling as the session store."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Protocol, TypeVar, cast

import sqlalchemy.exc
from geometrikks.server.exceptions import ApiKeysUnavailableError

from geometrikks.domain.auth.api_keys import ApiKeyRecord, ApiKeyScope, generate_api_key, hash_api_key
from geometrikks.domain.auth.models import ApiKey
from geometrikks.domain.auth.repositories import ApiKeyTableRepository
from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError, DomainValidationError
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.session_store import _OUTAGE_ERRORS, SESSION_STORE_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Awaitable, Callable
    from uuid import UUID

    from advanced_alchemy.extensions.litestar import SQLAlchemyAsyncConfig
    from litestar import Litestar

logger = get_logger(__name__)

API_KEY_NAME_MAX_LENGTH = 64
LAST_USED_WRITE_INTERVAL = timedelta(seconds=60)
REJECTION_LOG_INTERVAL = timedelta(seconds=60)
# Anyone can send a random gmk_ token, so the rejection map must not grow with the attacker.
REJECTION_LOG_MAX_ENTRIES = 10_000
# Without a share per IP, one client sending distinct tokens would fill the map and silence everyone.
REJECTION_LOG_MAX_ENTRIES_PER_IP = 100

_T = TypeVar("_T")


def utc_now() -> datetime:
    return datetime.now(UTC)


class ApiKeyRepository(Protocol):
    async def find_by_hash(self, key_hash: str) -> ApiKeyRecord | None: ...

    async def list_records(self) -> list[ApiKeyRecord]:
        """All keys, newest first."""
        ...

    async def insert(
        self,
        *,
        name: str,
        scope: ApiKeyScope,
        key_hash: str,
        display_prefix: str,
        created_by: str,
        expires_at: datetime | None,
    ) -> ApiKeyRecord:
        """Raises DomainConflictError when a key with the same name, ignoring case, exists."""
        ...

    async def delete(self, key_id: UUID) -> ApiKeyRecord | None: ...

    async def touch(self, key_id: UUID, *, at: datetime, ip: str | None) -> None: ...


def _to_record(api_key: ApiKey) -> ApiKeyRecord:
    return ApiKeyRecord(
        id=api_key.id,
        name=api_key.name,
        scope=cast("ApiKeyScope", api_key.scope),
        display_prefix=api_key.display_prefix,
        created_at=api_key.created_at,
        created_by=api_key.created_by,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        last_used_ip=api_key.last_used_ip,
    )


class SqlApiKeyRepository:
    """ApiKeyRepository over the api_keys table, one session per call.

    The auth middleware runs before dependency injection, so there is no
    request session to borrow.
    """

    def __init__(self, db_config: SQLAlchemyAsyncConfig) -> None:
        self.db_config = db_config

    @asynccontextmanager
    async def _table(self) -> AsyncGenerator[ApiKeyTableRepository]:
        """A repository on a fresh session, with Advanced Alchemy's error wrapping off.

        Wrapped, a dropped connection becomes an IntegrityError and reads as a
        duplicate name instead of a 503.
        """
        async with self.db_config.get_session() as session:
            yield ApiKeyTableRepository(session=session, wrap_exceptions=False)

    async def find_by_hash(self, key_hash: str) -> ApiKeyRecord | None:
        async with self._table() as table:
            api_key = await table.get_one_or_none(key_hash=key_hash)
            return None if api_key is None else _to_record(api_key)

    async def list_records(self) -> list[ApiKeyRecord]:
        async with self._table() as table:
            api_keys = await table.get_many(order_by=[(ApiKey.created_at, True), (ApiKey.id, True)])
            return [_to_record(api_key) for api_key in api_keys]

    async def insert(
        self,
        *,
        name: str,
        scope: ApiKeyScope,
        key_hash: str,
        display_prefix: str,
        created_by: str,
        expires_at: datetime | None,
    ) -> ApiKeyRecord:
        api_key = ApiKey(
            name=name,
            scope=scope,
            key_hash=key_hash,
            display_prefix=display_prefix,
            created_by=created_by,
            expires_at=expires_at,
        )
        async with self._table() as table:
            try:
                api_key = await table.add(api_key, auto_commit=True, auto_refresh=True)
            except sqlalchemy.exc.IntegrityError as error:
                raise DomainConflictError(f"An API key named {name!r} already exists.") from error
            return _to_record(api_key)

    async def delete(self, key_id: UUID) -> ApiKeyRecord | None:
        async with self._table() as table:
            api_key = await table.delete_returning(key_id)
            api_key_record = None if api_key is None else _to_record(api_key)
            await table.session.commit()
            return api_key_record

    async def touch(self, key_id: UUID, *, at: datetime, ip: str | None) -> None:
        async with self._table() as table:
            await table.set_last_used(key_id, at=at, ip=ip)
            await table.session.commit()


class ApiKeyStore:
    """Creates, looks up and revokes API keys. It answers 503 when the database is down.

    A database outage must read as "unavailable" to a monitor, not as a bad key.
    """

    def __init__(
        self,
        repository: ApiKeyRepository,
        *,
        is_available: Callable[[], bool],
        clock: Callable[[], datetime] = utc_now,
        timeout: float = SESSION_STORE_TIMEOUT_SECONDS,
    ) -> None:
        self.repository = repository
        self.is_available = is_available
        self.clock = clock
        self.timeout = timeout
        self._rejections_logged_at: dict[tuple[str, str | None], datetime] = {}
        self._live_rejections_by_ip: dict[str | None, int] = {}
        self._last_touch_by_key: dict[UUID, tuple[datetime, str | None]] = {}

    async def _call(self, operation: Callable[[], Awaitable[_T]]) -> _T:
        if not self.is_available():
            raise ApiKeysUnavailableError(detail="The API key store is unavailable.")
        try:
            async with asyncio.timeout(self.timeout):
                return await operation()
        except _OUTAGE_ERRORS as error:
            raise ApiKeysUnavailableError(detail="The API key store is unavailable.") from error

    async def authenticate(self, token: str) -> ApiKeyRecord | None:
        """The stored key for ``token``, expired or not, so the caller can name it when rejecting."""
        return await self._call(lambda: self.repository.find_by_hash(hash_api_key(token)))

    async def list_records(self) -> list[ApiKeyRecord]:
        return await self._call(self.repository.list_records)

    async def create(
        self, *, name: str, scope: ApiKeyScope, expires_at: datetime | None, created_by: str
    ) -> tuple[ApiKeyRecord, str]:
        """The new record and the full key. The key is never available again."""
        trimmed_name = name.strip()
        if not 1 <= len(trimmed_name) <= API_KEY_NAME_MAX_LENGTH:
            raise DomainValidationError(f"The name must be 1 to {API_KEY_NAME_MAX_LENGTH} characters.")
        if expires_at is not None and expires_at <= self.clock():
            raise DomainValidationError("The expiry date must be in the future.")
        material = generate_api_key()
        api_key_record = await self._call(
            lambda: self.repository.insert(
                name=trimmed_name,
                scope=scope,
                key_hash=material.key_hash,
                display_prefix=material.display_prefix,
                created_by=created_by,
                expires_at=expires_at,
            )
        )
        return api_key_record, material.key

    async def revoke(self, key_id: UUID) -> ApiKeyRecord:
        api_key_record = await self._call(lambda: self.repository.delete(key_id))
        self._last_touch_by_key.pop(key_id, None)
        if api_key_record is None:
            raise DomainNotFoundError("The API key does not exist.")
        return api_key_record

    async def record_use(self, record: ApiKeyRecord, ip: str | None) -> None:
        """Store when and from where ``record`` was last used. A failed write never fails the request."""
        now = self.clock()
        # Requests that authenticated before an earlier touch committed all carry the same
        # stale record, so this also checks the last touch this process started.
        for last_used_at, last_used_ip in (
            (record.last_used_at, record.last_used_ip),
            self._last_touch_by_key.get(record.id, (None, None)),
        ):
            if last_used_at is not None and now - last_used_at <= LAST_USED_WRITE_INTERVAL and last_used_ip == ip:
                return
        self._last_touch_by_key[record.id] = (now, ip)
        try:
            await self._call(lambda: self.repository.touch(record.id, at=now, ip=ip))
        except Exception:
            logger.warning("api_key_touch_failed", key_id=str(record.id), exc_info=True)

    def should_log_rejection(self, display_prefix: str, ip: str | None) -> bool:
        """True at most once a minute per (display prefix, IP), so a stale key polling does not flood the log."""
        now = self.clock()
        # New entries go at the back with the current time, so the oldest is always first.
        while self._rejections_logged_at:
            oldest_rejection, logged_at = next(iter(self._rejections_logged_at.items()))
            if now - logged_at < REJECTION_LOG_INTERVAL:
                break
            del self._rejections_logged_at[oldest_rejection]
            self._forget_live_rejection(oldest_rejection[1])
        rejection = (display_prefix, ip)
        if rejection in self._rejections_logged_at:
            return False
        live_rejections_for_ip = self._live_rejections_by_ip.get(ip, 0)
        if live_rejections_for_ip >= REJECTION_LOG_MAX_ENTRIES_PER_IP:
            return False
        if len(self._rejections_logged_at) >= REJECTION_LOG_MAX_ENTRIES:
            return False
        self._rejections_logged_at[rejection] = now
        self._live_rejections_by_ip[ip] = live_rejections_for_ip + 1
        return True

    def _forget_live_rejection(self, ip: str | None) -> None:
        live_rejections_for_ip = self._live_rejections_by_ip[ip] - 1
        if live_rejections_for_ip:
            self._live_rejections_by_ip[ip] = live_rejections_for_ip
        else:
            del self._live_rejections_by_ip[ip]


def install_api_key_store(app: Litestar, repository: ApiKeyRepository) -> ApiKeyStore:
    store = ApiKeyStore(repository, is_available=lambda: runtime.is_session_store_ready(app, default=True))
    app.state.api_key_store = store
    return store
