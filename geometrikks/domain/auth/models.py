"""Login sessions, their fingerprints, and API keys."""
from datetime import datetime

from advanced_alchemy import base
from advanced_alchemy.extensions.litestar.store import StoreModelMixin
from advanced_alchemy.types import DateTimeUTC
from sqlalchemy import Index, String, func
from sqlalchemy.orm import Mapped, mapped_column


class AuthSession(StoreModelMixin):
    """Key/value rows behind the session store.

    expires_at is NOT NULL, so every set() needs an expires_in.
    """

    __tablename__ = "auth_sessions"


class ApiKey(base.UUIDBase):
    """A named bearer key. The table stores only its SHA-256, and the UI shows the key once."""

    __tablename__ = "api_keys"
    __table_args__ = (Index("ix_api_keys_key_hash", "key_hash", unique=True),)

    name: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    display_prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True), nullable=False, server_default=func.now()
    )
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    last_used_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)


Index("ix_api_keys_lower_name", func.lower(ApiKey.name), unique=True)
