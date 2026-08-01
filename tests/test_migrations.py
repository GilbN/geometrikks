"""Alembic migration-chain sanity — no database required."""
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

REPO_ROOT = Path(__file__).resolve().parent.parent


def _script_directory() -> ScriptDirectory:
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "migrations"))
    return ScriptDirectory.from_config(cfg)


def test_single_head() -> None:
    """A forked migration history breaks `upgrade head`; exactly one head allowed."""
    heads = _script_directory().get_heads()
    assert len(heads) == 1, f"expected exactly one alembic head, got {heads}"


def test_revisions_parse_and_chain() -> None:
    """Every revision file loads and the chain walks back to base."""
    script = _script_directory()
    revisions = list(script.walk_revisions("base", "heads"))
    assert revisions, "no revisions found — baseline revision missing"
    # walk_revisions yields head → base; the last one is the root.
    assert revisions[-1].down_revision is None


from unittest.mock import MagicMock

import pytest

from geometrikks.config.settings import DatabaseSettings, Settings


class _FakeConn:
    """Records what migrate_database's drop path executes."""

    def __init__(self) -> None:
        self.executed: list[str] = []
        self.run_sync_calls: list[object] = []

    async def execute(self, stmt) -> None:
        self.executed.append(str(stmt))

    async def run_sync(self, fn) -> None:
        self.run_sync_calls.append(fn)


class _FakeEngine:
    def __init__(self) -> None:
        self.conn = _FakeConn()
        self.begin_count = 0

    def begin(self):
        engine = self

        class _Ctx:
            async def __aenter__(self):
                engine.begin_count += 1
                return engine.conn

            async def __aexit__(self, *exc) -> bool:
                return False

        return _Ctx()


def _settings(environment: str, drop: bool) -> Settings:
    return Settings(
        environment=environment,
        database=DatabaseSettings(drop_on_startup=drop),
    )


@pytest.fixture
def migration_mocks(monkeypatch):
    """Stub the side-effecting collaborators; record call order."""
    from geometrikks.server import migrations as mod

    order: list[str] = []
    monkeypatch.setattr(
        mod, "upgrade_to_head", lambda database_url=None: order.append("upgrade")
    )

    async def fake_teardown(conn) -> None:
        order.append("teardown")

    monkeypatch.setattr(mod, "teardown_timescaledb", fake_teardown)
    return order


async def test_drop_gate_runs_in_development(migration_mocks) -> None:
    from geometrikks.server.migrations import migrate_database

    engine = _FakeEngine()
    await migrate_database(engine, _settings("development", drop=True))

    assert engine.begin_count == 1
    assert migration_mocks == ["teardown", "upgrade"]
    assert engine.conn.run_sync_calls, "metadata.drop_all must run via run_sync"
    assert any("alembic_versions" in stmt for stmt in engine.conn.executed)


@pytest.mark.parametrize("environment", ["staging", "production"])
async def test_drop_gate_refused_outside_development(
    migration_mocks, caplog, environment
) -> None:
    from geometrikks.server.migrations import migrate_database

    engine = _FakeEngine()
    with caplog.at_level("ERROR", logger="geometrikks.server.migrations"):
        await migrate_database(engine, _settings(environment, drop=True))

    assert engine.begin_count == 0, "drop must not run outside development"
    assert migration_mocks == ["upgrade"], "upgrade still runs after the refusal"
    assert any("drop_on_startup ignored" in r.message for r in caplog.records)


async def test_no_drop_flag_goes_straight_to_upgrade(migration_mocks) -> None:
    from geometrikks.server.migrations import migrate_database

    engine = _FakeEngine()
    await migrate_database(engine, _settings("development", drop=False))

    assert engine.begin_count == 0
    assert migration_mocks == ["upgrade"]


async def test_upgrade_failure_propagates(monkeypatch) -> None:
    from geometrikks.server import migrations as mod

    def boom(database_url=None) -> None:
        raise RuntimeError("broken migration")

    monkeypatch.setattr(mod, "upgrade_to_head", boom)
    with pytest.raises(RuntimeError, match="broken migration"):
        await mod.migrate_database(_FakeEngine(), _settings("production", drop=False))


def test_upgrade_to_head_uses_dedicated_url_config(monkeypatch) -> None:
    """upgrade_to_head must build its own config from the settings URL, never
    reuse the app engine (env.py runs its own event loop via asyncio.run)."""
    from geometrikks.config.settings import get_settings
    from geometrikks.server import migrations as mod

    commands = MagicMock()
    monkeypatch.setattr(mod, "AlembicCommands", commands)

    mod.upgrade_to_head()

    (config,), _ = commands.call_args
    assert config.connection_string == get_settings().database.url
    assert config.engine_instance is None
    assert config.alembic_config.script_location == "migrations"
    commands.return_value.upgrade.assert_called_once_with(revision="head")


def test_upgrade_to_head_honors_explicit_url(monkeypatch) -> None:
    """migrate_database passes the app-bound URL; ambient settings must not win."""
    from geometrikks.server import migrations as mod

    commands = MagicMock()
    monkeypatch.setattr(mod, "AlembicCommands", commands)

    mod.upgrade_to_head("postgresql+asyncpg://x:y@explicit.invalid:5432/appdb")

    (config,), _ = commands.call_args
    assert config.connection_string == "postgresql+asyncpg://x:y@explicit.invalid:5432/appdb"


from types import SimpleNamespace

pytestmark = pytest.mark.anyio


async def test_on_startup_migrates_before_timescale(monkeypatch) -> None:
    """Migrations own the schema; setup_timescaledb depends on the tables
    existing, so it must run strictly after migrate_database."""
    from geometrikks.server import lifecycle as lc

    order: list[str] = []

    async def fake_db_available(app, timeout: float = 10.0) -> bool:
        return True

    async def fake_migrate(engine, settings) -> None:
        order.append("migrate")

    async def fake_timescale(engine, analytics) -> None:
        order.append("timescale")

    async def fake_create_scheduler(session_maker, settings, crowdsec_poller=None):
        scheduler = MagicMock()
        scheduler.start = MagicMock()
        return scheduler

    ingestion = MagicMock()

    async def fake_start(**kwargs) -> None:
        order.append("ingestion")

    ingestion.start = fake_start

    sqlalchemy_config = MagicMock()
    sqlalchemy_config.get_engine.return_value = MagicMock()
    sqlalchemy_config.create_session_maker.return_value = MagicMock()

    monkeypatch.setattr(lc, "_db_available", fake_db_available)
    monkeypatch.setattr(lc, "get_app_db_config", lambda app: sqlalchemy_config)
    monkeypatch.setattr(lc, "migrate_database", fake_migrate)
    monkeypatch.setattr(lc, "setup_timescaledb", fake_timescale)
    monkeypatch.setattr(lc, "create_scheduler", fake_create_scheduler)
    monkeypatch.setattr(lc, "LogParser", MagicMock())
    monkeypatch.setattr(lc, "LogIngestionService", MagicMock(return_value=ingestion))

    app = SimpleNamespace(state=SimpleNamespace())
    await lc.on_startup(app)

    assert order == ["migrate", "timescale", "ingestion"]
