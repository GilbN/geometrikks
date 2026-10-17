"""The /api/v1/instances routes through the full app composition."""
from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

import pytest
import structlog
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine

from geometrikks.config.settings import (
    DatabaseSettings,
    LogParserSettings,
    MapSettings,
    SchedulerSettings,
    Settings,
    get_installed_version,
)
from geometrikks.domain.instances.repositories import HeartbeatWrite, upsert_heartbeat
from geometrikks.server import runtime
from geometrikks.server.core import create_app
from geometrikks.server.schema_wait import bundled_head_revision, known_revisions
from geometrikks.services.geoip.self_location import SelfLocation
from geometrikks.services.geoip.server_locations import upsert_auto_server_locations

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _reset_structlog_config():
    """See test_geo_locations_api_pg.py: undo StructlogPlugin's global config
    so later capture_logs() calls in other modules are not bypassed."""
    from geometrikks.server.logging import ensure_default_configuration

    yield
    structlog.reset_defaults()
    ensure_default_configuration()


def _make_settings(migrated_database_url: str) -> Settings:
    url = make_url(migrated_database_url)
    assert url.host is not None and url.username is not None
    assert url.password is not None and url.database is not None
    return Settings(
        auth_disabled=True,
        database=DatabaseSettings(
            host=url.host,
            port=url.port or 5432,
            user=url.username,
            password=url.password,
            database=url.database,
        ),
        scheduler=SchedulerSettings(enabled=False),
        logparser=LogParserSettings(enabled=False),
        map=MapSettings(server_latitude=59.91, server_longitude=10.75),
    )


async def _seed_agent(
    pg_engine: AsyncEngine,
    instance_name: str,
    *,
    schema_revision: str | None = None,
    app_version: str | None = None,
    payload: dict | None = None,
) -> None:
    heartbeat_write = HeartbeatWrite(
        instance_name=instance_name,
        boot_id=uuid4(),
        mode="agent",
        app_version=app_version or get_installed_version(),
        schema_revision=schema_revision or bundled_head_revision(),
        started_at=datetime.now(timezone.utc),
        payload=payload if payload is not None else {"instanceNameSource": "configured"},
    )
    async with pg_engine.begin() as connection:
        await upsert_heartbeat(connection, heartbeat_write)


async def _set_age(pg_engine: AsyncEngine, instance_name: str, interval: str) -> None:
    async with pg_engine.begin() as connection:
        await connection.execute(
            text(f"UPDATE instance_heartbeats SET last_seen = now() - interval '{interval}' WHERE instance_name = :name"),
            {"name": instance_name},
        )


async def _write_own_row(client: AsyncTestClient, app) -> None:
    """Beat on the app's own event loop: AsyncTestClient runs the app in a portal thread."""
    writer = runtime.get_heartbeat_writer(app)
    assert writer is not None
    assert client.blocking_portal.call(writer.beat) is True


async def _get_instances(client: AsyncTestClient) -> dict:
    response = await client.get("/api/v1/instances/")
    assert response.status_code == 200, response.text
    return response.json()


async def test_list_includes_self_first(migrated_database_url, pg_engine, clean_instance_heartbeats):
    await _seed_agent(pg_engine, "aaa-agent")
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _write_own_row(client, app)
        body = await _get_instances(client)

    instances = body["instances"]
    assert [instance["instanceName"] for instance in instances] == ["head", "aaa-agent"]
    assert instances[0]["isSelf"] is True
    assert instances[1]["isSelf"] is False
    assert body["head"]["instanceName"] == "head"
    assert body["head"]["schemaRevision"] == bundled_head_revision()
    assert body["checkedAt"]


async def test_list_flags_schema_behind_agent(migrated_database_url, pg_engine, clean_instance_heartbeats):
    older_revisions = sorted(known_revisions() - {bundled_head_revision()})
    assert older_revisions, "needs at least two bundled migrations"
    await _seed_agent(pg_engine, "old-agent", schema_revision=older_revisions[0])
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _write_own_row(client, app)
        body = await _get_instances(client)

    agent = next(instance for instance in body["instances"] if instance["instanceName"] == "old-agent")
    assert agent["status"] == "critical"
    assert "instance-schema-behind" in {problem["id"] for problem in agent["problems"]}


async def test_staleness_uses_database_clock(migrated_database_url, pg_engine, clean_instance_heartbeats):
    await _seed_agent(pg_engine, "slow-agent")
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _set_age(pg_engine, "slow-agent", "4 minutes")
        stale = await _get_instances(client)
        await _set_age(pg_engine, "slow-agent", "1 minute")
        fresh = await _get_instances(client)

    def checking_in(body: dict) -> bool:
        return next(i for i in body["instances"] if i["instanceName"] == "slow-agent")["checkingIn"]

    assert checking_in(stale) is False
    assert checking_in(fresh) is True


async def test_list_works_with_scheduler_disabled(migrated_database_url, pg_engine, clean_instance_heartbeats):
    await _seed_agent(pg_engine, "quiet-agent")
    settings = _make_settings(migrated_database_url)
    assert settings.scheduler.enabled is False
    app = create_app(settings=settings)
    async with AsyncTestClient(app=app) as client:
        body = await _get_instances(client)

    assert "quiet-agent" in {instance["instanceName"] for instance in body["instances"]}


async def test_server_locations_attach_by_payload_server_names(
    migrated_database_url, pg_engine, pg_session_maker, clean_instance_heartbeats, clean_server_locations
):
    await upsert_auto_server_locations(
        pg_session_maker,
        ["nginx-01", "other-01"],
        SelfLocation(latitude=60.39, longitude=5.32, source="external_ip"),
    )
    await _seed_agent(
        pg_engine,
        "edge-agent",
        payload={"instanceNameSource": "configured", "serverNames": ["nginx-01", "never-located"]},
    )
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        body = await _get_instances(client)

    agent = next(instance for instance in body["instances"] if instance["instanceName"] == "edge-agent")
    assert [location["server"] for location in agent["serverLocations"]] == ["nginx-01"]
    location = agent["serverLocations"][0]
    assert location["latitude"] == pytest.approx(60.39)
    assert location["longitude"] == pytest.approx(5.32)
    assert location["source"] == "auto"
    assert location["detectedAt"] is not None


async def test_health_field_is_typed_when_payload_carries_a_report(
    migrated_database_url, pg_engine, clean_instance_heartbeats
):
    await _seed_agent(pg_engine, "bare-agent")
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _write_own_row(client, app)
        body = await _get_instances(client)

    by_name = {instance["instanceName"]: instance for instance in body["instances"]}
    assert by_name["bare-agent"]["health"] is None
    assert by_name["head"]["health"]["status"] in {"healthy", "degraded"}


async def test_delete_removes_agent_and_logs(migrated_database_url, pg_engine, clean_instance_heartbeats):
    await _seed_agent(pg_engine, "retired agent")
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        with structlog.testing.capture_logs() as captured:
            deleted = await client.delete(f"/api/v1/instances/{quote('retired agent', safe='')}")
        body = await _get_instances(client)

    assert deleted.status_code == 204
    assert "retired agent" not in {instance["instanceName"] for instance in body["instances"]}
    removed = [event for event in captured if event["event"] == "agent_removed"]
    assert len(removed) == 1
    assert removed[0]["instance_name"] == "retired agent"
    assert removed[0]["actor"]
    assert removed[0]["last_seen"] is not None


async def test_delete_unknown_is_404(migrated_database_url, clean_instance_heartbeats):
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        response = await client.delete("/api/v1/instances/never-seen")

    assert response.status_code == 404


async def test_delete_self_is_409(migrated_database_url, pg_engine, clean_instance_heartbeats):
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _write_own_row(client, app)
        response = await client.delete("/api/v1/instances/head")
        body = await _get_instances(client)

    assert response.status_code == 409
    assert "head" in {instance["instanceName"] for instance in body["instances"]}


async def test_health_carries_no_instance_data(migrated_database_url, pg_engine, clean_instance_heartbeats):
    await _seed_agent(pg_engine, "secret-agent-name", app_version="9.9.9-secret")
    app = create_app(settings=_make_settings(migrated_database_url))
    async with AsyncTestClient(app=app) as client:
        await _write_own_row(client, app)
        response = await client.get("/health")

    assert response.status_code == 200
    assert "secret-agent-name" not in response.text
    assert "9.9.9-secret" not in response.text
