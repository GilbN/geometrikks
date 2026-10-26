"""Login sessions and their fingerprints, one row per key within a namespace."""
from advanced_alchemy.extensions.litestar.store import StoreModelMixin


class AuthSession(StoreModelMixin):
    """Key/value rows behind the session store.

    expires_at is NOT NULL, so every set() needs an expires_in.
    """

    __tablename__ = "auth_sessions"
