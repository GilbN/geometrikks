"""The /api/v1/muted-ips routes on the full app against Postgres."""
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import structlog.testing
from advanced_alchemy.extensions.litestar import EngineConfig, SQLAlchemyAsyncConfig
from litestar.testing import AsyncTestClient
from pydantic import SecretStr
from sqlalchemy.pool import NullPool

from geometrikks.config.settings import Settings
from geometrikks.domain.auth.api_keys import generate_api_key
from geometrikks.domain.muted_ips.repositories import MutedIpRepository
from geometrikks.server.api_key_store import SqlApiKeyRepository
from geometrikks.server.core import create_app
from tests.integration.test_drop_snapshot_pg import build_settings

pytestmark = pytest.mark.anyio

URL = "/api/v1/muted-ips/"


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    return build_settings(migrated_database_url)


@pytest.fixture()
async def client(app_settings: Settings) -> AsyncIterator[AsyncTestClient]:
    async with AsyncTestClient(app=create_app(settings=app_settings)) as test_client:
        yield test_client


async def test_post_returns_stored_form_and_lists_oldest_first(client, clean_muted_ips):
    first = await client.post(URL, json={"network": "10.0.0.5/8", "note": " lab "})
    assert first.status_code == 201
    assert first.json()["network"] == "10.0.0.0/8"
    assert first.json()["note"] == "lab"
    await client.post(URL, json={"network": "2001:db8::5"})
    listed = await client.get(URL)
    assert [entry["network"] for entry in listed.json()] == ["10.0.0.0/8", "2001:db8::5/128"]


async def test_duplicate_spelling_is_409_muted_ip_exists(client, clean_muted_ips):
    await client.post(URL, json={"network": "::ffff:203.0.113.7"})
    response = await client.post(URL, json={"network": "203.0.113.7"})
    assert (response.status_code, response.json()["code"]) == (409, "muted_ip_exists")


async def test_full_list_is_409_and_duplicate_still_wins(client, clean_muted_ips):
    for index in range(20):
        await client.post(URL, json={"network": f"198.51.100.{index}"})
    full = await client.post(URL, json={"network": "192.0.2.1"})
    assert (full.status_code, full.json()["code"]) == (409, "muted_ip_list_full")
    duplicate = await client.post(URL, json={"network": "198.51.100.0"})
    assert (duplicate.status_code, duplicate.json()["code"]) == (409, "muted_ip_exists")


async def test_bad_input_codes(client, clean_muted_ips):
    bad_network = await client.post(URL, json={"network": "fe80::1%eth0"})
    assert (bad_network.status_code, bad_network.json()["code"]) == (400, "invalid_network")
    bad_note = await client.post(URL, json={"network": "192.0.2.1", "note": "x" * 101})
    assert (bad_note.status_code, bad_note.json()["code"]) == (400, "invalid_note")
    wrong_type = await client.post(URL, content="network=1.2.3.4", headers={"content-type": "text/plain"})
    assert wrong_type.status_code == 415


async def test_delete_then_404(client, clean_muted_ips):
    entry = (await client.post(URL, json={"network": "192.0.2.1"})).json()
    assert (await client.delete(f"{URL}{entry['id']}")).status_code == 204
    assert (await client.delete(f"{URL}{entry['id']}")).status_code == 404
    assert (await client.get(URL)).json() == []


async def test_writes_log_events_without_note(client, clean_muted_ips):
    with structlog.testing.capture_logs() as logs:
        created = await client.post(URL, json={"network": "192.0.2.1", "note": "secret"})
        await client.delete(f"{URL}{created.json()['id']}")
    added = [log_event for log_event in logs if log_event["event"] == "muted_ip_added"]
    removed = [log_event for log_event in logs if log_event["event"] == "muted_ip_removed"]
    assert added and added[0]["network"] == "192.0.2.1/32"
    assert removed and removed[0]["network"] == "192.0.2.1/32"
    assert "secret" not in str(logs)


@pytest.fixture()
async def key_db_config(migrated_database_url: str) -> AsyncIterator[SQLAlchemyAsyncConfig]:
    config = SQLAlchemyAsyncConfig(
        connection_string=migrated_database_url, engine_config=EngineConfig(poolclass=NullPool)
    )
    yield config
    await config.get_engine().dispose()


@pytest.fixture()
async def client_with_auth(app_settings: Settings) -> AsyncIterator[AsyncTestClient]:
    auth_settings = app_settings.model_copy(
        update={
            "auth_disabled": False,
            "admin_user": "admin",
            "admin_password": SecretStr("bestpasswordintheworldnojoke"),
        }
    )
    app = create_app(settings=auth_settings)
    async with AsyncTestClient(app=app) as test_client:
        yield test_client


async def test_read_key_can_list_but_not_write(client_with_auth, key_db_config, clean_muted_ips, clean_api_keys):
    client = client_with_auth
    material = generate_api_key()
    await SqlApiKeyRepository(key_db_config).insert(
        name="reader",
        scope="read",
        key_hash=material.key_hash,
        display_prefix=material.display_prefix,
        created_by="admin",
        expires_at=None,
    )
    headers = {"Authorization": f"Bearer {material.key}"}
    assert (await client.get(URL, headers=headers)).status_code == 200
    posted = await client.post(URL, json={"network": "192.0.2.1"}, headers=headers)
    assert (posted.status_code, posted.json()["code"]) == (403, "api_key_read_only")
    deleted = await client.delete(f"{URL}00000000-0000-0000-0000-000000000000", headers=headers)
    assert (deleted.status_code, deleted.json()["code"]) == (403, "api_key_read_only")


async def test_insert_conflict_past_the_pre_check_is_409_and_rolls_back(
    client, clean_muted_ips, monkeypatch
):
    await client.post(URL, json={"network": "203.0.113.7"})

    async def never_exists(self, *args, **kwargs):
        return False

    monkeypatch.setattr(MutedIpRepository, "exists", never_exists)
    with structlog.testing.capture_logs() as logs:
        response = await client.post(URL, json={"network": "203.0.113.7"})
    assert (response.status_code, response.json()["code"]) == (409, "muted_ip_exists")
    assert not [log_event for log_event in logs if log_event["event"] == "muted_ip_added"]
    listed = await client.get(URL)
    assert [entry["network"] for entry in listed.json()] == ["203.0.113.7/32"]
    monkeypatch.undo()
    assert (await client.post(URL, json={"network": "203.0.113.8"})).status_code == 201
