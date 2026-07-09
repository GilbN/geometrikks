"""Unit tests for the auth core: hashing, verification, config gating."""
from __future__ import annotations

import pytest

from geometrikks.config.settings import Settings


def _settings(**kwargs) -> Settings:
    return Settings(**kwargs)


class TestBuildAuthState:
    def test_password_is_hashed_not_stored_plain(self):
        from geometrikks.server.auth import build_auth_state
        state = build_auth_state(_settings(admin_password="bestpasswordintheworldnojoke"))
        assert "bestpasswordintheworldnojoke" not in state.password_hash
        assert state.password_hash.startswith("$argon2")

    def test_verify_accepts_correct_credentials(self):
        from geometrikks.server.auth import build_auth_state
        state = build_auth_state(_settings(admin_user="gil", admin_password="bestpasswordintheworldnojoke"))
        assert state.verify("gil", "bestpasswordintheworldnojoke") is True

    def test_verify_rejects_wrong_password_and_wrong_user(self):
        from geometrikks.server.auth import build_auth_state
        state = build_auth_state(_settings(admin_user="gil", admin_password="bestpasswordintheworldnojoke"))
        assert state.verify("gil", "wrong") is False
        assert state.verify("other", "bestpasswordintheworldnojoke") is False

    def test_missing_password_raises_when_auth_enabled(self):
        from geometrikks.server.auth import build_auth_state
        with pytest.raises(RuntimeError, match="APP_ADMIN_PASSWORD"):
            build_auth_state(_settings(admin_password=None))


class TestRetrieveUserHandler:
    async def test_returns_admin_user_for_valid_session(self):
        from geometrikks.server.auth import AdminUser, retrieve_user_handler
        user = await retrieve_user_handler({"username": "admin"}, None)
        assert user == AdminUser(username="admin")

    async def test_returns_none_for_empty_session(self):
        from geometrikks.server.auth import retrieve_user_handler
        assert await retrieve_user_handler({}, None) is None
