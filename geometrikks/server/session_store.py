"""Postgres-backed session storage, so a restart does not log users out."""
from advanced_alchemy.extensions.litestar import SQLAlchemyAsyncConfig
from advanced_alchemy.extensions.litestar.store import SQLAlchemyStore
from sqlalchemy import delete, func

from geometrikks.domain.auth.models import AuthSession

SESSION_NAMESPACE = "sessions"
FINGERPRINT_NAMESPACE = "auth_fingerprint"


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
