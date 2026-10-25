"""Login sessions and their fingerprints, one row per key within a namespace."""
from advanced_alchemy.extensions.litestar.store import StoreModelMixin


class AuthSession(StoreModelMixin):
    """Key/value rows behind the session store; expires_at is stamped on write."""

    __tablename__ = "auth_sessions"
