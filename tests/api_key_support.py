"""An in-memory ApiKeyRepository for unit tests."""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from geometrikks.domain.auth.api_keys import ApiKeyRecord, ApiKeyScope
from geometrikks.domain.exceptions import DomainConflictError

if TYPE_CHECKING:
    from collections.abc import Callable


class MemoryApiKeyRepository:
    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.clock = clock
        self.records_by_hash: dict[str, ApiKeyRecord] = {}
        self.touches: list[tuple[UUID, datetime, str | None]] = []
        self.touch_error: BaseException | None = None
        self.find_error: BaseException | None = None

    async def find_by_hash(self, key_hash: str) -> ApiKeyRecord | None:
        if self.find_error is not None:
            raise self.find_error
        return self.records_by_hash.get(key_hash)

    async def list_records(self) -> list[ApiKeyRecord]:
        return sorted(self.records_by_hash.values(), key=lambda api_key_record: api_key_record.created_at, reverse=True)

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
        if any(api_key_record.name.lower() == name.lower() for api_key_record in self.records_by_hash.values()):
            raise DomainConflictError(f"An API key named {name!r} already exists.")
        api_key_record = ApiKeyRecord(
            id=uuid4(),
            name=name,
            scope=scope,
            display_prefix=display_prefix,
            created_at=self.clock(),
            created_by=created_by,
            expires_at=expires_at,
            last_used_at=None,
            last_used_ip=None,
        )
        self.records_by_hash[key_hash] = api_key_record
        return api_key_record

    async def delete(self, key_id: UUID) -> ApiKeyRecord | None:
        for key_hash, api_key_record in self.records_by_hash.items():
            if api_key_record.id == key_id:
                del self.records_by_hash[key_hash]
                return api_key_record
        return None

    async def touch(self, key_id: UUID, *, at: datetime, ip: str | None) -> None:
        if self.touch_error is not None:
            raise self.touch_error
        self.touches.append((key_id, at, ip))
        for key_hash, api_key_record in self.records_by_hash.items():
            if api_key_record.id == key_id:
                self.records_by_hash[key_hash] = dataclasses.replace(
                    api_key_record, last_used_at=at, last_used_ip=ip
                )
