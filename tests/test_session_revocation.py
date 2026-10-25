"""Startup revocation of every session when the auth settings change."""
from __future__ import annotations

import threading
from collections.abc import MutableMapping
from datetime import timedelta
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest
from litestar.stores.memory import MemoryStore
from structlog.testing import capture_logs

from geometrikks.config.settings import OidcSettings, Settings
from geometrikks.server.session_revocation import (
    FINGERPRINT_KEY,
    SessionRevocationError,
    auth_fingerprint_material,
    revoke_sessions_if_auth_changed,
)
from geometrikks.server.session_store import FINGERPRINT_NAMESPACE, SESSION_NAMESPACE

pytestmark = pytest.mark.anyio


def _oidc(**overrides: Any) -> OidcSettings:
    values: dict[str, Any] = {
        "issuer": "http://127.0.0.1:9",
        "client_id": "geo",
        "client_secret": "s3cret",
        "redirect_uri": "http://localhost/api/v1/auth/oidc/callback",
        "allowed_users": ["alice@example.com"],
    }
    values.update(overrides)
    return OidcSettings(_env_file=None, **values)


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "admin_user": "admin",
        "admin_password": "bestpasswordintheworldnojoke",
        "oidc": _oidc(),
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def _revoked_reasons(captured: list[MutableMapping[str, Any]]) -> list[str]:
    return [log_entry["reason"] for log_entry in captured if log_entry["event"] == "sessions_revoked"]


async def test_first_start_stores_a_fingerprint_and_revokes():
    sessions, fingerprints = MemoryStore(), MemoryStore()

    assert await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings()) is True

    stored = await fingerprints.get(FINGERPRINT_KEY)
    assert stored is not None
    assert stored.startswith(b"$argon2")


async def test_unchanged_settings_keep_sessions():
    sessions, fingerprints = MemoryStore(), MemoryStore()
    await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())
    await sessions.set("session-1", b"payload", expires_in=3600)

    assert await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings()) is False
    assert await sessions.get("session-1") == b"payload"


@pytest.mark.parametrize(
    "changed",
    [
        pytest.param({"admin_password": "anotherpasswordentirely"}, id="admin-password"),
        pytest.param({"admin_user": "gil"}, id="admin-user"),
        pytest.param({"oidc": _oidc(allowed_users=["bob@example.com"])}, id="oidc-allowed-users"),
        pytest.param({"oidc": _oidc(scopes="openid email")}, id="oidc-scopes"),
        pytest.param({"oidc": _oidc(allowed_groups=["admins"])}, id="oidc-allowed-groups"),
        pytest.param({"oidc": _oidc(groups_claim="roles")}, id="oidc-groups-claim"),
        pytest.param({"oidc": _oidc(issuer="http://127.0.0.1:10")}, id="oidc-issuer"),
        pytest.param({"admin_password": None}, id="password-login-off"),
    ],
)
async def test_a_changed_setting_revokes_every_session(changed: dict[str, Any]):
    sessions, fingerprints = MemoryStore(), MemoryStore()
    await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())
    await sessions.set("session-1", b"payload", expires_in=3600)

    with capture_logs() as captured:
        revoked = await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings(**changed))

    assert revoked is True
    assert await sessions.get("session-1") is None
    assert _revoked_reasons(captured) == ["auth_settings_changed"]


async def test_a_missing_fingerprint_clears_existing_sessions():
    sessions, fingerprints = MemoryStore(), MemoryStore()
    await sessions.set("session-1", b"payload", expires_in=3600)

    with capture_logs() as captured:
        assert await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings()) is True
    assert await sessions.get("session-1") is None
    assert _revoked_reasons(captured) == ["no_fingerprint"]


async def test_a_stored_value_that_is_no_hash_counts_as_a_change():
    sessions, fingerprints = MemoryStore(), MemoryStore()
    await fingerprints.set(FINGERPRINT_KEY, b"not-a-hash", expires_in=3600)
    await sessions.set("session-1", b"payload", expires_in=3600)

    with capture_logs() as captured:
        assert await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings()) is True
    assert await sessions.get("session-1") is None
    assert _revoked_reasons(captured) == ["invalid_fingerprint"]
    stored = await fingerprints.get(FINGERPRINT_KEY)
    assert stored is not None
    assert stored.startswith(b"$argon2")


class FailingSetStore(MemoryStore):
    """Fails every set like a DBAPIError would: the bound value in the message."""

    def __init__(self) -> None:
        super().__init__()
        self.failing = True
        self.attempted: list[bytes] = []

    async def set(self, key: str, value: str | bytes, expires_in: int | timedelta | None = None) -> None:
        value_bytes = value.encode() if isinstance(value, str) else value
        if self.failing:
            self.attempted.append(value_bytes)
            raise RuntimeError(f"connection lost [parameters: ({key!r}, {value_bytes!r})]")
        await super().set(key, value, expires_in=expires_in)


def _exception_chain(error: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    pending: list[BaseException | None] = [error]
    while pending:
        current = pending.pop()
        if current is None or current in chain:
            continue
        chain.append(current)
        pending.extend([current.__cause__, current.__context__])
    return chain


async def test_a_failed_store_write_keeps_the_hash_out_of_the_error():
    sessions, fingerprints = MemoryStore(), FailingSetStore()

    with pytest.raises(SessionRevocationError) as raised:
        await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())

    [attempted_hash] = fingerprints.attempted
    assert attempted_hash.startswith(b"$argon2")
    for error in _exception_chain(raised.value):
        assert attempted_hash.decode() not in str(error)
        assert attempted_hash.decode() not in repr(error.args)
    assert "RuntimeError" in str(raised.value)


class MissingTableStore(MemoryStore):
    """Fails every call the way a missing auth_sessions table would."""

    async def get(self, key: str, renew_for: int | timedelta | None = None) -> bytes | None:
        raise RuntimeError('relation "auth_sessions" does not exist')

    async def delete_all(self) -> None:
        raise RuntimeError('relation "auth_sessions" does not exist')


async def test_a_failed_fingerprint_read_names_its_cause():
    with pytest.raises(SessionRevocationError) as raised:
        await revoke_sessions_if_auth_changed(MemoryStore(), MissingTableStore(), _settings())

    assert "read the auth fingerprint" in str(raised.value)
    assert 'relation "auth_sessions" does not exist' in str(raised.value)


async def test_a_failed_session_delete_names_its_cause():
    with pytest.raises(SessionRevocationError) as raised:
        await revoke_sessions_if_auth_changed(MissingTableStore(), MemoryStore(), _settings())

    assert "delete the sessions" in str(raised.value)
    assert 'relation "auth_sessions" does not exist' in str(raised.value)


async def test_a_revocation_whose_write_failed_runs_again_next_start():
    sessions, fingerprints = MemoryStore(), FailingSetStore()
    with pytest.raises(SessionRevocationError):
        await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())
    await sessions.set("session-1", b"payload", expires_in=3600)
    fingerprints.failing = False

    assert await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings()) is True
    assert await sessions.get("session-1") is None


async def test_hashing_runs_off_the_event_loop(monkeypatch):
    from geometrikks.server import session_revocation

    threads: list[threading.Thread] = []
    real_hasher = session_revocation._hasher

    class RecordingHasher:
        def hash(self, password: str) -> str:
            threads.append(threading.current_thread())
            return real_hasher.hash(password)

        def verify(self, password: str, hash: str | bytes) -> bool:
            threads.append(threading.current_thread())
            return real_hasher.verify(password, hash)

    monkeypatch.setattr(session_revocation, "_hasher", RecordingHasher())
    sessions, fingerprints = MemoryStore(), MemoryStore()
    await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())
    await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())

    assert len(threads) == 2
    assert all(thread is not threading.main_thread() for thread in threads)


def test_the_material_does_not_depend_on_list_order():
    forward = _settings(oidc=_oidc(allowed_users=["a", "b"]))
    backward = _settings(oidc=_oidc(allowed_users=["b", "a"]))

    assert auth_fingerprint_material(forward) == auth_fingerprint_material(backward)


async def test_the_log_event_carries_no_secret():
    sessions, fingerprints = MemoryStore(), MemoryStore()

    with capture_logs() as captured:
        await revoke_sessions_if_auth_changed(sessions, fingerprints, _settings())

    rendered = repr(captured)
    assert "bestpasswordintheworldnojoke" not in rendered
    assert "$argon2" not in rendered


def _patch_bring_up(monkeypatch, lc) -> tuple[AsyncMock, MagicMock]:
    monkeypatch.setattr(lc, "get_app_db_config", lambda app: MagicMock())
    monkeypatch.setattr(lc, "migrate_database", AsyncMock())
    monkeypatch.setattr(lc, "setup_timescaledb", AsyncMock())
    monkeypatch.setattr(lc, "reconcile_override_server_locations", AsyncMock())
    monkeypatch.setattr(lc, "upsert_auto_server_locations", AsyncMock())
    revoke = AsyncMock(return_value=False)
    monkeypatch.setattr(lc, "revoke_sessions_if_auth_changed", revoke)
    create_store = MagicMock(side_effect=lambda db_config, namespace: namespace)
    monkeypatch.setattr(lc, "create_session_table_store", create_store)
    return revoke, create_store


async def test_bring_up_database_checks_the_fingerprint_after_timescale(monkeypatch):
    from geometrikks.server import lifecycle as lc

    revoke, _ = _patch_bring_up(monkeypatch, lc)
    order: list[str] = []
    cast("AsyncMock", lc.setup_timescaledb).side_effect = lambda *args: order.append("timescale")
    revoke.side_effect = lambda *args: order.append("revoke")
    settings = _settings()

    await lc.bring_up_database(cast("Any", SimpleNamespace(state=SimpleNamespace(settings=settings))))

    assert order == ["timescale", "revoke"]
    revoke.assert_awaited_once_with(SESSION_NAMESPACE, FINGERPRINT_NAMESPACE, settings)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param(
            {"auth_disabled": True, "admin_password": None, "oidc": OidcSettings(_env_file=None)},
            id="auth-disabled",
        ),
        pytest.param({"app": {"mode": "agent"}}, id="agent"),
    ],
)
async def test_bring_up_database_leaves_sessions_alone_without_auth(monkeypatch, overrides):
    from geometrikks.server import lifecycle as lc

    revoke, _ = _patch_bring_up(monkeypatch, lc)
    settings = _settings(**overrides)

    await lc.bring_up_database(cast("Any", SimpleNamespace(state=SimpleNamespace(settings=settings))))

    revoke.assert_not_awaited()


async def test_a_failed_revocation_fails_startup(monkeypatch):
    from geometrikks.server import lifecycle as lc

    revoke, _ = _patch_bring_up(monkeypatch, lc)
    revoke.side_effect = RuntimeError("store down")

    with pytest.raises(RuntimeError, match="store down"):
        await lc.bring_up_database(
            cast("Any", SimpleNamespace(state=SimpleNamespace(settings=_settings())))
        )
