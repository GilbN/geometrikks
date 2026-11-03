"""Generating, hashing and checking API keys, and the record stored for each."""

from __future__ import annotations

import hashlib
import re
import secrets
import string
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID

API_KEY_PREFIX = "gmk_"
API_KEY_BODY_LENGTH = 43
API_KEY_DISPLAY_PREFIX_LENGTH = 8

ApiKeyScope = Literal["read", "read_write"]

_BASE62_ALPHABET = string.digits + string.ascii_uppercase + string.ascii_lowercase
_WELL_FORMED_KEY = re.compile(rf"{API_KEY_PREFIX}[0-9A-Za-z]{{{API_KEY_BODY_LENGTH}}}")


@dataclass(frozen=True)
class NewApiKeyMaterial:
    key: str
    display_prefix: str
    key_hash: str


@dataclass(frozen=True)
class ApiKeyRecord:
    id: UUID
    name: str
    scope: ApiKeyScope
    display_prefix: str
    created_at: datetime
    created_by: str
    expires_at: datetime | None
    last_used_at: datetime | None
    last_used_ip: str | None

    def is_expired(self, now: datetime) -> bool:
        return self.expires_at is not None and self.expires_at <= now


def hash_api_key(key: str) -> str:
    """The stored lookup hash, so a leaked table holds no usable keys."""
    return hashlib.sha256(key.encode()).hexdigest()


def display_prefix_of(token: str) -> str:
    return token[:API_KEY_DISPLAY_PREFIX_LENGTH]


def generate_api_key() -> NewApiKeyMaterial:
    body = "".join(secrets.choice(_BASE62_ALPHABET) for _ in range(API_KEY_BODY_LENGTH))
    key = API_KEY_PREFIX + body
    return NewApiKeyMaterial(key=key, display_prefix=display_prefix_of(key), key_hash=hash_api_key(key))


def is_api_key_token(token: str) -> bool:
    return token.startswith(API_KEY_PREFIX)


def is_well_formed_api_key(token: str) -> bool:
    return _WELL_FORMED_KEY.fullmatch(token) is not None
