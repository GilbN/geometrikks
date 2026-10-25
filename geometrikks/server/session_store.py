"""Postgres-backed session storage, so a restart does not log users out."""

from __future__ import annotations

import asyncio
import hashlib
from typing import TYPE_CHECKING, TypeVar

import asyncpg
import sqlalchemy.exc
from advanced_alchemy.extensions.litestar import SQLAlchemyAsyncConfig
from advanced_alchemy.extensions.litestar.store import SQLAlchemyStore
from litestar.exceptions import ServiceUnavailableException
from litestar.stores.base import Store
from sqlalchemy import delete, func

from geometrikks.domain.auth.models import AuthSession
from geometrikks.server import runtime

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from datetime import timedelta

    from litestar import Litestar

SESSION_NAMESPACE = "sessions"
FINGERPRINT_NAMESPACE = "auth_fingerprint"
SESSION_STORE_TIMEOUT_SECONDS = 5.0

_T = TypeVar("_T")

# Failures that mean "the database cannot be reached right now". SQLAlchemy
# wraps driver errors only on an open connection, so errors from
# asyncpg.connect (the server is starting up, too many connections) arrive
# raw. Anything else is a bug and must keep its traceback.
_OUTAGE_ERRORS: tuple[type[BaseException], ...] = (
    OSError,
    TimeoutError,
    asyncpg.PostgresError,
    asyncpg.InterfaceError,
    sqlalchemy.exc.OperationalError,
    sqlalchemy.exc.InterfaceError,
    sqlalchemy.exc.DisconnectionError,
    sqlalchemy.exc.TimeoutError,
)


class SessionTableStore(SQLAlchemyStore[SQLAlchemyAsyncConfig]):
    """SQLAlchemyStore whose cleanup is limited to its own namespace."""

    async def delete_expired(self) -> None:
        async with self._get_async_session() as session, session.begin():
            await session.execute(
                delete(AuthSession).where(
                    AuthSession.namespace == self.namespace,
                    AuthSession.expires_at <= func.now(),
                )
            )


def create_session_table_store(
    db_config: SQLAlchemyAsyncConfig, namespace: str = SESSION_NAMESPACE
) -> SessionTableStore:
    return SessionTableStore(db_config, model=AuthSession, namespace=namespace)


def hash_session_id(session_id: str) -> str:
    """The store key for a session cookie value, so a leaked table holds no live cookies."""
    return hashlib.sha256(session_id.encode()).hexdigest()


class SessionStore(Store):
    """The app's ``sessions`` store: hashes keys and fails with a 503.

    Without it a store outage reads as "no session": the auth middleware
    answers 401 and the SPA sends the user to the login page, although the
    session is still valid and will be back with the database.
    """

    def __init__(
        self,
        inner: Store,
        *,
        is_available: Callable[[], bool],
        timeout: float = SESSION_STORE_TIMEOUT_SECONDS,
    ) -> None:
        self.inner = inner
        self.is_available = is_available
        self.timeout = timeout

    async def _call(self, operation: Callable[[], Awaitable[_T]]) -> _T:
        if not self.is_available():
            raise ServiceUnavailableException(detail="The session store is unavailable.")
        try:
            async with asyncio.timeout(self.timeout):
                return await operation()
        except _OUTAGE_ERRORS as error:
            raise ServiceUnavailableException(detail="The session store is unavailable.") from error

    async def set(self, key: str, value: str | bytes, expires_in: int | timedelta | None = None) -> None:
        await self._call(lambda: self.inner.set(hash_session_id(key), value, expires_in=expires_in))

    async def get(self, key: str, renew_for: int | timedelta | None = None) -> bytes | None:
        return await self._call(lambda: self.inner.get(hash_session_id(key), renew_for=renew_for))

    async def delete(self, key: str) -> None:
        await self._call(lambda: self.inner.delete(hash_session_id(key)))

    async def delete_all(self) -> None:
        await self._call(self.inner.delete_all)

    async def exists(self, key: str) -> bool:
        return await self._call(lambda: self.inner.exists(hash_session_id(key)))

    async def expires_in(self, key: str) -> int | None:
        return await self._call(lambda: self.inner.expires_in(hash_session_id(key)))

    async def delete_expired(self) -> None:
        sweep = getattr(self.inner, "delete_expired", None)
        if not callable(sweep):
            return
        await self._call(sweep)


def install_session_store(app: Litestar, inner: Store) -> SessionStore:
    """Register the ``sessions`` store over ``inner``.

    Call before the first request: the session backend reads the store from
    the registry per request, and register() refuses a name already taken.
    """
    store = SessionStore(inner, is_available=lambda: runtime.is_db_available(app, default=True))
    app.stores.register("sessions", store)
    return store
