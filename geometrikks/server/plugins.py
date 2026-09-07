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
from typing import TYPE_CHECKING, Any, Literal

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

    from geometrikks.server.lifecycle import LifecyclePlugin

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
    """Keep the live-events queue running while the LISTEN connection recovers."""

    _RECONNECT_INITIAL_DELAY = 1
    _RECONNECT_MAX_DELAY = 30

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.degraded = False
        self._pub_conn: Any | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._install_task: asyncio.Task[Any] | None = None
        self._closing = False
        # Installing and subscribing must share a lock so no channel misses
        # the candidate's LISTEN replay just before it becomes visible.
        self._sub_lock = asyncio.Lock()
        self._recovered = asyncio.Event()

    @property
    def state(self) -> Literal["ok", "degraded", "reconnecting"]:
        if self.degraded:
            return "degraded"
        if not self._recovered.is_set() and self._reconnect_task is not None:
            return "reconnecting"
        return "ok"

    async def on_startup(self) -> None:
        # The plugin's stream keeps this queue through every connection retry.
        self._queue = asyncio.Queue()
        try:
            await self._install_listener()
        except Exception as exc:
            self.degraded = True
            logger.warning("channels_backend_degraded", error=str(exc))
            self._ensure_retry()

    async def recover(self) -> None:
        """Retry degraded startup, raising on failure while background retries continue."""
        if self._closing:
            raise RuntimeError("Channels backend is shutting down")
        if not self.degraded:
            return
        try:
            await self._install_listener()
        finally:
            if self.degraded:
                self._ensure_retry()

    async def _close_listener(self, conn: Any) -> None:
        # asyncpg fires termination listeners even on an intentional close.
        with contextlib.suppress(Exception):
            conn.remove_termination_listener(self._on_listener_terminated)
        with contextlib.suppress(Exception):
            await conn.close()

    async def _install_listener(self) -> None:
        async with self._sub_lock:
            if self._closing:
                raise RuntimeError("Channels backend is shutting down")
            if self._recovered.is_set():
                return
            self._install_task = asyncio.current_task()
            conn: Any | None = None
            try:
                conn = await self._connect()
                conn.add_termination_listener(self._on_listener_terminated)
                for channel in list(self._subscribed_channels):
                    await conn.add_listener(channel, self._listener)
                if self._closing:
                    raise RuntimeError("Channels backend is shutting down")
                if conn.is_closed():
                    raise OSError("Channels listener closed during registration")
            except BaseException:
                if conn is not None:
                    # Shutdown can cancel an install whose caller already
                    # cancelled it. Finish closing before releasing the lock.
                    cleanup = asyncio.create_task(self._close_listener(conn))
                    cancelled = False
                    while not cleanup.done():
                        try:
                            await asyncio.shield(cleanup)
                        except asyncio.CancelledError:
                            cancelled = True
                    cleanup.result()
                    if cancelled:
                        raise asyncio.CancelledError
                raise
            finally:
                self._install_task = None
            self._listener_conn = conn
            self.degraded = False
            self._recovered.set()
            logger.info("channels_backend_recovered")

    def _ensure_retry(self) -> None:
        if self._closing:
            return
        if self._reconnect_task is None or self._reconnect_task.done():
            self._reconnect_task = asyncio.get_running_loop().create_task(self._reconnect_listener())

    def _on_listener_terminated(self, connection: Any) -> None:
        """asyncpg callbacks must not raise, including during cleanup."""
        if self._closing or connection is not getattr(self, "_listener_conn", None):
            return
        self._recovered.clear()
        try:
            logger.error("channels listener connection lost; attempting automatic reconnect")
            self._ensure_retry()
        except Exception:  # pragma: no cover - callback must not cascade
            pass

    async def _reconnect_listener(self) -> None:
        delay = self._RECONNECT_INITIAL_DELAY
        if self.degraded:
            await asyncio.sleep(delay)
        while not self._closing:
            try:
                await self._install_listener()
            except Exception as exc:
                logger.warning("channels_listener_reconnect_failed", error=str(exc))
                await asyncio.sleep(delay)
                delay = min(delay * 2, self._RECONNECT_MAX_DELAY)
                continue
            return

    async def on_shutdown(self) -> None:
        self._closing = True
        tasks = {task for task in (self._reconnect_task, self._install_task) if task is not None}
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._reconnect_task = None
        async with self._sub_lock:
            if self._pub_conn is not None:
                with contextlib.suppress(Exception):
                    await self._pub_conn.close()
                self._pub_conn = None
            conn = getattr(self, "_listener_conn", None)
            if conn is not None:
                await self._close_listener(conn)
                del self._listener_conn
            self._queue = None
            self._recovered.clear()
        logger.info("channels_backend_stopped")

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
        if self.degraded or self._closing:
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
        async with self._sub_lock:
            if self._closing:
                return
            if self.degraded:
                self._subscribed_channels.update(channels)
                return
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
        """Deliberate no-op: the LISTEN is persistent for the process lifetime.

        The plugin tears the backend subscription down when the last
        `/ws/live` client disconnects and re-subscribes on the next one. On
        a page refresh those two calls race in both orders, and a stale
        unsubscribe decision (made while the subscriber set was momentarily
        empty) can land after the new client's subscribe no-opped, killing
        the LISTEN the plugin believes that client holds. Serializing the
        backend calls cannot fix decision staleness, so with a single
        declared channel the robust ordering fix is to never UNLISTEN at
        all: startup subscribes, shutdown closes the connection, and client
        churn changes nothing in between. The cost is one idle NOTIFY
        consumer while no clients are connected.
        """
        del channels

    async def stream_events(self) -> AsyncGenerator[tuple[str, bytes], None]:
        if self.degraded:
            await self._recovered.wait()
        async for item in super().stream_events():
            yield item


def create_channels_plugin(
    settings: Settings, backend: DegradedTolerantAsyncPgBackend | None = None
) -> ChannelsPlugin:
    """Cross-process live-events fan-out over Postgres LISTEN/NOTIFY."""
    return ChannelsPlugin(
        backend=(
            backend if backend is not None else DegradedTolerantAsyncPgBackend(dsn=settings.database.asyncpg_dsn)
        ),
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
    | LifecyclePlugin
]:
    """Instantiate all app plugins; called once from create_app().

    include_vite=False for agent mode: no SPA to build/serve, and the Vite
    plugin would otherwise try to reach a dev server or bundled assets that
    a headless log-tailing process has no use for.
    """
    from geometrikks.cli import ImportLogsCLIPlugin
    from geometrikks.server.lifecycle import LifecyclePlugin

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
        | LifecyclePlugin
    ] = [
        SQLAlchemyInitPlugin(config=db_config),
        GeoAlchemyPlugin(),  # GeoAlchemy plugin for PostGIS support
        GranianPlugin(),
    ]
    if include_vite:
        plugin_list.append(VitePlugin(config=create_vite_config(settings)))
    channels_backend = DegradedTolerantAsyncPgBackend(dsn=settings.database.asyncpg_dsn)
    plugin_list.extend(
        [
            ImportLogsCLIPlugin(),
            create_structlog_plugin(settings),
            create_channels_plugin(settings, channels_backend),
            # Last on purpose: its lifespan managers must nest inside the
            # channels plugin's (see lifecycle.LifecyclePlugin).
            LifecyclePlugin(channels_backend=channels_backend),
        ]
    )
    return plugin_list
