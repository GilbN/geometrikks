"""Factory functions for plugin instances and configurations.

Nothing in this module is constructed at import time — settings (and therefore
engine, vite config, and logging config) are only built when a factory is
called from create_app() or the lifecycle hooks. This keeps imports working
when e.g. the GeoIP database is missing.
"""

from __future__ import annotations
import asyncio
import contextlib
import platform
import shutil
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

from litestar.channels import ChannelsPlugin
from litestar.channels.backends.asyncpg import AsyncPgChannelsBackend
from litestar.middleware.logging import LoggingMiddlewareConfig
from litestar.plugins.structlog import StructlogConfig, StructlogPlugin
from litestar.serialization import decode_json, encode_json
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from advanced_alchemy import base
from advanced_alchemy.extensions.litestar import (
    AsyncSessionConfig,
    SQLAlchemyAsyncConfig,
    SQLAlchemyInitPlugin,
)

from litestar.plugins import CLIPlugin
from litestar_geoalchemy import GeoAlchemyPlugin
from litestar_granian import GranianPlugin
from litestar_vite import ViteConfig, VitePlugin
from litestar_vite.config import RuntimeConfig, TypeGenConfig, PathConfig

from geometrikks.config.settings import get_settings, Settings
from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL
from geometrikks.server.logging import get_logger, create_logging_config

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Iterable

    from litestar import Litestar

logger = get_logger(__name__)


def create_sqlalchemy_config(settings: Settings) -> SQLAlchemyAsyncConfig:
    """Build an async engine and SQLAlchemy config from explicit settings."""
    engine = create_async_engine(
        url=settings.database.url,
        echo=settings.database.echo,
        pool_size=settings.database.pool_size,
        max_overflow=settings.database.max_overflow,
        pool_timeout=settings.database.pool_timeout,
        pool_recycle=settings.database.pool_recycle,
        future=True,
        json_serializer=encode_json,
        json_deserializer=decode_json,
        echo_pool=settings.database.echo_pool,
        pool_pre_ping=settings.database.pool_pre_ping,
        pool_use_lifo=True,  # use lifo to reduce the number of idle connections
        poolclass=NullPool if settings.database.pool_disabled else None,
    )
    return SQLAlchemyAsyncConfig(
        engine_instance=engine,
        session_config=AsyncSessionConfig(expire_on_commit=False),
        create_all=False,
        metadata=base.DefaultBase.metadata,
    )


@lru_cache(maxsize=1)
def get_sqlalchemy_config() -> SQLAlchemyAsyncConfig:
    """Process-cached engine/config from ambient settings.

    For contexts with no composed app (the import-logs CLI, hand-built test
    apps). App code paths should resolve the app-bound config through
    get_app_db_config() so create_app(settings=...) governs the database.
    """
    return create_sqlalchemy_config(get_settings())


def get_app_db_config(app: Litestar) -> SQLAlchemyAsyncConfig:
    """The SQLAlchemy config the app was composed with.

    create_app() stores its config on app.state; the fallback keeps
    hand-built test apps (which never went through create_app) working
    against the process-cached config.
    """
    config = getattr(app.state, "db_config", None)
    return config if config is not None else get_sqlalchemy_config()


def create_vite_config(settings: Settings) -> ViteConfig:
    return ViteConfig(
        mode="spa",
        runtime=RuntimeConfig(
            dev_mode=settings.vite.dev_mode,
            http2=settings.vite.http2,
            host=settings.vite.host,
            port=settings.vite.port,
            executor=settings.vite.executor,
            start_dev_server=settings.vite.use_server_lifespan,
            is_react=settings.vite.enable_react_helpers,
            # litestar-vite 0.25 executor bug on Windows: it compares run_command[0]
            # against shutil.which("bun") case-sensitively ("bun" vs "bun.EXE"), fails,
            # and prepends the binary — running `bun.EXE bun run dev` (bun's legacy
            # bundler). Using the same which() result as the command head sidesteps it.
            run_command=(
                [shutil.which("bun") or "bun", "run", "dev"]
                if platform.system() == "Windows"
                else None
            ),
        ),
        types=TypeGenConfig(
            output=Path("resources/generated"),
            generate_zod=True,
            generate_sdk=True,
            generate_routes=True,
            generate_page_props=True,
        ),
        paths=PathConfig(
            resource_dir=Path("resources"),
            bundle_dir=Path("public"),
        ),
    )


def create_structlog_plugin(settings: Settings) -> StructlogPlugin:
    """Structlog pipeline + structured request logging middleware."""
    return StructlogPlugin(
        config=StructlogConfig(
            structlog_logging_config=create_logging_config(settings),
            middleware_logging_config=LoggingMiddlewareConfig(
                response_log_fields=("status_code",),
                request_log_fields=("path", "method", "query", "path_params"),
            ),
        )
    )


class DegradedTolerantAsyncPgBackend(AsyncPgChannelsBackend):
    """AsyncPg channels backend that degrades instead of failing startup.

    ChannelsPlugin connects during app startup; an unreachable database must
    put the app in the existing DB-degraded mode, not crash boot. When
    degraded, publish and subscribe are no-ops and the event stream stays
    silent; /ws/live independently gates on db_available and closes 1013.
    """

    _RECONNECT_INITIAL_DELAY = 1
    _RECONNECT_MAX_DELAY = 30

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.degraded = False
        self._pub_conn: Any | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._closing = False
        # Serializes subscribe/unsubscribe. A page refresh makes the plugin
        # unsubscribe the departing /ws/live client and subscribe the new one
        # concurrently; without the lock, subscribe can interleave into
        # unsubscribe's awaited UNLISTEN, read the not-yet-updated
        # bookkeeping as "already subscribed", and skip its LISTEN -- leaving
        # the process deaf to NOTIFYs until another full cycle.
        self._sub_lock = asyncio.Lock()

    async def on_startup(self) -> None:
        try:
            await super().on_startup()
        except Exception as exc:
            self.degraded = True
            logger.warning("Channels backend degraded (DB unreachable): %s", exc)
            return
        self._listener_conn.add_termination_listener(self._on_listener_terminated)

    def _on_listener_terminated(self, connection: Any) -> None:
        """Surface a dropped LISTEN connection and self-heal it.

        Must never raise: asyncpg schedules this via call_soon/create_task,
        and an escaping exception there is unhandled by our code. A graceful
        on_shutdown() unregisters this callback before closing, so reaching
        here means the drop was unexpected -- log it and, unless we're
        already shutting down or already recovering, spawn the reconnect
        loop.
        """
        try:
            logger.error(
                "channels listener connection lost; attempting automatic reconnect"
            )
        except Exception:  # pragma: no cover - logging itself must not cascade
            pass
        if self._closing:
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            return
        self._reconnect_task = asyncio.get_running_loop().create_task(self._reconnect_listener())

    async def _reconnect_listener(self) -> None:
        """Rebuild the LISTEN connection with capped exponential backoff.

        Each attempt redoes exactly what on_startup() + subscribe() did:
        open a fresh connection, register the termination callback, and
        LISTEN every channel still in `_subscribed_channels`. subscribe()
        itself won't re-issue LISTEN for channels already in that set, so
        the re-registration goes straight through add_listener() instead.
        """
        delay = self._RECONNECT_INITIAL_DELAY
        while not self._closing:
            new_conn: Any | None = None
            try:
                new_conn = await self._connect()
                new_conn.add_termination_listener(self._on_listener_terminated)
                # Snapshot: subscribe() mutates this set in place, and a
                # /ws/live client connecting mid-reconnect would otherwise
                # blow up the iteration ("set changed size") and waste an
                # attempt. A channel added after the snapshot stays tracked
                # and heals on a later reconnect, same as any subscribe that
                # hits the dead-connection window. In production the set is
                # a single fixed channel, so that window is a startup edge.
                for channel in list(self._subscribed_channels):
                    await new_conn.add_listener(channel, self._listener)
            except Exception as exc:
                logger.warning("channels listener reconnect attempt failed: %s", exc)
                if new_conn is not None:
                    # Unregister first: closing an abandoned connection that
                    # still carries the just-added termination callback
                    # would fire it and log a false "listener connection
                    # lost" ERROR for a cleanup close, even though a retry
                    # follows immediately after.
                    with contextlib.suppress(Exception):
                        new_conn.remove_termination_listener(self._on_listener_terminated)
                    with contextlib.suppress(Exception):
                        await new_conn.close()
                await asyncio.sleep(delay)
                delay = min(delay * 2, self._RECONNECT_MAX_DELAY)
                continue
            self._listener_conn = new_conn
            logger.info("channels listener reconnected")
            return

    async def on_shutdown(self) -> None:
        self._closing = True
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reconnect_task
            self._reconnect_task = None
        if self.degraded:
            return
        if self._pub_conn is not None:
            with contextlib.suppress(Exception):
                await self._pub_conn.close()
            self._pub_conn = None
        # asyncpg fires termination listeners on a graceful close() too (via
        # Connection._cleanup()), not just on an unexpected drop. Unregister
        # first so a normal shutdown doesn't log a false "listener lost"
        # alarm; remove_termination_listener() uses set.discard() internally
        # so it is a no-op if the listener was never added.
        try:
            self._listener_conn.remove_termination_listener(self._on_listener_terminated)
        except Exception:  # pragma: no cover - shutdown must not be blocked by this
            pass
        await super().on_shutdown()

    async def publish(self, data: bytes, channels: Iterable[str]) -> None:
        """Publish over one lazily opened, reused connection.

        The parent opens/closes a fresh asyncpg connection per call, which is
        too slow for a live-events feed. We keep our own connection instead
        of calling super().publish(); a failed publish drops that event
        (lossy feed is spec-sanctioned) and clears the connection so the next
        publish reopens it. A connection the server dropped is only noticed
        here via the ``execute()`` call itself failing, so the event that
        surfaces the drop is the one cost of detecting it -- there is no
        earlier signal to catch it on.
        """
        if self.degraded:
            return
        try:
            if self._pub_conn is None or self._pub_conn.is_closed():
                self._pub_conn = await self._connect()
            dec_data = data.decode("utf-8")
            for channel in channels:
                await self._pub_conn.execute("SELECT pg_notify($1, $2);", channel, dec_data)
        except Exception as exc:
            logger.warning("live event publish failed; event lost (transient DB failure?): %s", exc)
            if self._pub_conn is not None:
                with contextlib.suppress(Exception):
                    await self._pub_conn.close()
            self._pub_conn = None

    async def subscribe(self, channels: Iterable[str]) -> None:
        """LISTEN each not-yet-tracked channel; tolerate a dead listener conn.

        During the reconnect window ``self._listener_conn`` is dead, and a
        `/ws/live` client can connect right then. Reimplemented (rather than
        wrapping ``super().subscribe()`` in one try/except) because the
        parent adds each channel to ``_subscribed_channels`` only *after*
        its LISTEN succeeds, inside the same per-channel loop iteration: one
        try/except around the whole call would stop the bookkeeping at the
        first failing channel too. Tracking every requested channel
        regardless of LISTEN failure means the reconnect loop's re-LISTEN
        (which walks `_subscribed_channels`) heals it once the connection
        is replaced.
        """
        if self.degraded:
            return
        async with self._sub_lock:
            for channel in set(channels) - self._subscribed_channels:
                try:
                    await self._listener_conn.add_listener(channel, self._listener)  # type: ignore[arg-type]
                except Exception as exc:
                    logger.warning(
                        "channels subscribe(%r) failed against a dead listener "
                        "connection; tracked anyway, the next reconnect will "
                        "re-LISTEN it: %s",
                        channel,
                        exc,
                    )
                self._subscribed_channels.add(channel)

    async def unsubscribe(self, channels: Iterable[str]) -> None:
        """UNLISTEN each channel; tolerate a dead listener conn.

        Reimplemented for the same reason as subscribe(): the parent only
        drops channels from ``_subscribed_channels`` after the whole
        UNLISTEN loop completes, so a single try/except around
        ``super().unsubscribe()`` would leave every channel (including ones
        already unlistened) stuck in the tracked set if any UNLISTEN call
        raised. Removing from the tracked set regardless of the call's
        outcome keeps a disconnecting `/ws/live` client from leaving a
        stale entry that the next reconnect's re-LISTEN would wrongly
        restore.
        """
        if self.degraded:
            return
        async with self._sub_lock:
            for channel in channels:
                try:
                    await self._listener_conn.remove_listener(channel, self._listener)  # type: ignore[arg-type]
                except Exception as exc:
                    logger.warning(
                        "channels unsubscribe(%r) failed against a dead listener "
                        "connection; untracked anyway: %s",
                        channel,
                        exc,
                    )
            self._subscribed_channels = self._subscribed_channels - set(channels)

    async def stream_events(self) -> AsyncGenerator[tuple[str, bytes], None]:
        if self.degraded:
            await asyncio.Event().wait()  # silent forever; plugin task parks here
        async for item in super().stream_events():
            yield item


def create_channels_plugin(settings: Settings) -> ChannelsPlugin:
    """Cross-process live-events fan-out over Postgres LISTEN/NOTIFY."""
    return ChannelsPlugin(
        backend=DegradedTolerantAsyncPgBackend(dsn=settings.database.asyncpg_dsn),
        channels=[LIVE_EVENTS_CHANNEL],
        arbitrary_channels_allowed=False,
        subscriber_max_backlog=1000,
        subscriber_backlog_strategy="dropleft",
    )


def create_plugins(
    settings: Settings | None = None,
    db_config: SQLAlchemyAsyncConfig | None = None,
    include_vite: bool = True,
) -> list[
    SQLAlchemyInitPlugin
    | GeoAlchemyPlugin
    | GranianPlugin
    | VitePlugin
    | CLIPlugin
    | StructlogPlugin
    | ChannelsPlugin
]:
    """Instantiate all app plugins; called once from create_app().

    include_vite=False for agent mode: no SPA to build/serve, and the Vite
    plugin would otherwise try to reach a dev server or bundled assets that
    a headless log-tailing process has no use for.
    """
    from geometrikks.cli import ImportLogsCLIPlugin

    if db_config is None:
        # Explicit settings must also govern the SQLAlchemy plugin; only a
        # fully ambient call may use the process-cached config.
        db_config = get_sqlalchemy_config() if settings is None else create_sqlalchemy_config(settings)
    if settings is None:
        settings = get_settings()
    plugin_list: list[
        SQLAlchemyInitPlugin
        | GeoAlchemyPlugin
        | GranianPlugin
        | VitePlugin
        | CLIPlugin
        | StructlogPlugin
        | ChannelsPlugin
    ] = [
        SQLAlchemyInitPlugin(config=db_config),
        GeoAlchemyPlugin(),  # GeoAlchemy plugin for PostGIS support
        GranianPlugin(),
    ]
    if include_vite:
        plugin_list.append(VitePlugin(config=create_vite_config(settings)))
    plugin_list.extend(
        [
            ImportLogsCLIPlugin(),
            create_structlog_plugin(settings),
            create_channels_plugin(settings),
        ]
    )
    return plugin_list
