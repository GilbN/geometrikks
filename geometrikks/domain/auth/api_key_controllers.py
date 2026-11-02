"""Session-only endpoints that list, create and revoke API keys."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

import msgspec
from litestar import Controller, Request, delete, get, post
from litestar.di import NamedDependency
from litestar.exceptions import ServiceUnavailableException
from litestar.params import FromPath, JSONBody, SkipValidation

from geometrikks.config.settings import Settings
from geometrikks.domain.auth.api_keys import ApiKeyRecord, ApiKeyScope
from geometrikks.domain.exceptions import DomainConflictError
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server import runtime
from geometrikks.server.api_key_auth import requires_session_user
from geometrikks.server.api_key_store import API_KEY_NAME_MAX_LENGTH, ApiKeyStore
from geometrikks.server.auth import AdminUser
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger

login_logger = get_logger(LOGIN_LOGGER_NAME)

AUTH_DISABLED_DETAIL = "API keys need the built-in login. With APP_AUTH_DISABLED=true the API is already open."


class ApiKeyView(msgspec.Struct, kw_only=True, rename="camel"):
    """A stored key. The key itself is never part of it."""

    id: UUID
    name: str
    scope: ApiKeyScope
    display_prefix: str
    created_at: datetime
    created_by: str
    expires_at: datetime | None
    last_used_at: datetime | None
    last_used_ip: str | None
    expired: bool

    @classmethod
    def from_record(cls, api_key_record: ApiKeyRecord, now: datetime) -> ApiKeyView:
        return cls(
            id=api_key_record.id,
            name=api_key_record.name,
            scope=api_key_record.scope,
            display_prefix=api_key_record.display_prefix,
            created_at=api_key_record.created_at,
            created_by=api_key_record.created_by,
            expires_at=api_key_record.expires_at,
            last_used_at=api_key_record.last_used_at,
            last_used_ip=api_key_record.last_used_ip,
            expired=api_key_record.is_expired(now),
        )


class ApiKeyList(msgspec.Struct, rename="camel"):
    """``available`` is false with APP_AUTH_DISABLED=true, where keys cannot exist."""

    available: bool
    keys: list[ApiKeyView]


class CreateApiKeyPayload(msgspec.Struct, kw_only=True, rename="camel"):
    name: Annotated[str, msgspec.Meta(min_length=1, max_length=API_KEY_NAME_MAX_LENGTH)]
    scope: ApiKeyScope = "read"
    expires_at: Annotated[datetime, msgspec.Meta(tz=True)] | None = None


class CreatedApiKey(msgspec.Struct, rename="camel"):
    """The only response that ever carries the full key."""

    api_key: ApiKeyView
    key: str


def _store_for(request: Request) -> ApiKeyStore:
    store = runtime.get_api_key_store(request.app)
    if store is None:
        raise ServiceUnavailableException(detail="API keys are unavailable.")
    return store


def _expires_at_field(api_key_record: ApiKeyRecord) -> str | None:
    return None if api_key_record.expires_at is None else api_key_record.expires_at.isoformat()


class ApiKeyController(Controller):
    """Registered in every mode, like AuthController, so the settings page gets an answer
    instead of a 404 with APP_AUTH_DISABLED=true."""

    path = "/auth/api-keys"
    tags = ["Auth"]
    guards = [requires_session_user]

    @get("/")
    async def list_api_keys(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> ApiKeyList:
        if settings.auth_disabled:
            return ApiKeyList(available=False, keys=[])
        store = _store_for(request)
        api_key_records = await store.list_records()
        now = store.clock()
        return ApiKeyList(
            available=True,
            keys=[ApiKeyView.from_record(api_key_record, now) for api_key_record in api_key_records],
        )

    @post("/")
    async def create_api_key(
        self,
        request: Request,
        data: JSONBody[CreateApiKeyPayload],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> CreatedApiKey:
        if settings.auth_disabled:
            raise DomainConflictError(AUTH_DISABLED_DETAIL)
        store = _store_for(request)
        admin_user: AdminUser = request.user
        api_key_record, api_key = await store.create(
            name=data.name.strip(),
            scope=data.scope,
            expires_at=data.expires_at,
            created_by=admin_user.username,
        )
        login_logger.info(
            "api_key_created",
            user=admin_user.username,
            ip=resolve_client_ip(request),
            key=api_key_record.name,
            scope=api_key_record.scope,
            expires_at=_expires_at_field(api_key_record),
        )
        return CreatedApiKey(api_key=ApiKeyView.from_record(api_key_record, store.clock()), key=api_key)

    @delete("/{key_id:uuid}")
    async def revoke_api_key(
        self,
        request: Request,
        key_id: FromPath[UUID],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> None:
        if settings.auth_disabled:
            raise DomainConflictError(AUTH_DISABLED_DETAIL)
        store = _store_for(request)
        admin_user: AdminUser = request.user
        api_key_record = await store.revoke(key_id)
        login_logger.info(
            "api_key_revoked",
            user=admin_user.username,
            ip=resolve_client_ip(request),
            key=api_key_record.name,
            scope=api_key_record.scope,
            expires_at=_expires_at_field(api_key_record),
        )
