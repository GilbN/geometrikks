"""The background task that writes this instance's row in instance_heartbeats."""
import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

import msgspec
from litestar import Litestar
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from geometrikks.config.settings import Settings, get_installed_version
from geometrikks.domain.instances.payload import RollingCounter, build_payload
from geometrikks.domain.instances.repositories import (
    HeartbeatWrite,
    PreviousHeartbeat,
    read_heartbeat,
    upsert_heartbeat,
)
from geometrikks.domain.instances.schemas import HeartbeatPayload, decode_payload
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.schema_wait import bundled_head_revision

logger = get_logger(__name__)

HEARTBEAT_INTERVAL_SECONDS = 30.0
NAME_CONFLICT_THRESHOLD = 3
NAME_CONFLICT_WINDOW_SECONDS = 300.0
RECENT_STARTS_KEPT = 10
# The head's first beats race its own migration, and an agent's first beats
# fail until the head has migrated, so failures this soon after start() log at debug.
STARTUP_GRACE_SECONDS = 120.0

_WRITE_TIMEOUT_SECONDS = 10.0
_COUNTER_WINDOW_SECONDS = 300.0


@dataclass(frozen=True, slots=True)
class WindowCounts:
    """Increases over the last 5 minutes; None until a full window was sampled."""

    lines: int | None = None
    failed_records: int | None = None
    written_records: int | None = None
    failed_batches: int | None = None


class HeartbeatWriter:
    """Upserts this instance's heartbeat every interval until stopped.

    A failed write never stops the loop: the table may not exist yet while
    the head migrates, or the database may be down, and the next tick retries.
    """

    def __init__(
        self,
        app: Litestar,
        settings: Settings,
        engine: AsyncEngine,
        *,
        boot_id: UUID | None = None,
        interval: float = HEARTBEAT_INTERVAL_SECONDS,
        _clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.boot_id = boot_id or uuid4()
        self._clock = _clock
        self._started_monotonic: float | None = None
        self._app = app
        self._settings = settings
        self._engine = engine
        self._interval = interval
        self._instance_name = settings.resolved_instance_name
        self._app_version = get_installed_version()
        self._schema_revision: str | None = None
        self._started_at = runtime.get_started_at(app) or datetime.now(timezone.utc)
        self._task: asyncio.Task[None] | None = None
        self._lines_counter = RollingCounter(window_seconds=_COUNTER_WINDOW_SECONDS)
        self._failed_counter = RollingCounter(window_seconds=_COUNTER_WINDOW_SECONDS)
        self._written_counter = RollingCounter(window_seconds=_COUNTER_WINDOW_SECONDS)
        self._failed_batches_counter = RollingCounter(window_seconds=_COUNTER_WINDOW_SECONDS)
        self._counted_service: object | None = None
        # None until the first successful write has merged the previous row's starts.
        self._recent_starts: list[datetime] | None = None
        self._foreign_sightings: deque[float] = deque()
        self._name_conflict_at: datetime | None = None
        self._conflict_logged = False
        self._failing = False

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._started_monotonic = self._clock()
        self._task = asyncio.create_task(self._run(), name="heartbeat-writer")
        logger.info(
            "heartbeat_writer_started",
            instance_name=self._instance_name,
            boot_id=str(self.boot_id),
            interval_seconds=self._interval,
        )

    async def stop(self) -> None:
        task = self._task
        if task is None:
            return
        task.cancel()
        # wait() never raises the task's CancelledError, so a cancel aimed at
        # the caller still propagates instead of being swallowed here.
        await asyncio.wait([task])
        if self._task is task:
            self._task = None
            logger.info("heartbeat_writer_stopped", instance_name=self._instance_name)

    async def _run(self) -> None:
        while True:
            await self.beat()
            await asyncio.sleep(self._interval)

    async def beat(self) -> bool:
        """Write one heartbeat; False when the write failed."""
        try:
            await asyncio.wait_for(self._write(), timeout=_WRITE_TIMEOUT_SECONDS)
        except Exception as error:
            self._record_failure(error)
            return False
        if self._failing:
            self._failing = False
            logger.info("heartbeat_write_recovered", instance_name=self._instance_name)
        return True

    def _record_failure(self, error: Exception) -> None:
        in_startup_grace = (
            self._started_monotonic is not None
            and self._clock() - self._started_monotonic < STARTUP_GRACE_SECONDS
        )
        log = logger.debug if self._failing or in_startup_grace else logger.warning
        if not in_startup_grace:
            self._failing = True
        log(
            "heartbeat_write_failed",
            instance_name=self._instance_name,
            error=str(error) or type(error).__name__,
        )

    async def _write(self) -> None:
        if self._schema_revision is None:
            self._schema_revision = bundled_head_revision()
        schema_revision = self._schema_revision
        at_monotonic = self._clock()
        window_counts = self._sample_counters(at_monotonic)

        async with self._engine.begin() as connection:
            first_write = self._recent_starts is None
            if self._recent_starts is None:
                recent_starts = await self._merge_recent_starts(connection)
            else:
                recent_starts = self._recent_starts
            payload = build_payload(
                self._app,
                self._settings,
                lines_5m=window_counts.lines,
                failed_5m=window_counts.failed_records,
                written_5m=window_counts.written_records,
                failed_batches_5m=window_counts.failed_batches,
                recent_starts=recent_starts,
                name_conflict_at=self._name_conflict_at,
            )
            previous_heartbeat = await upsert_heartbeat(
                connection, self._heartbeat_write(payload, schema_revision)
            )
            if not first_write and self._track_conflict(at_monotonic, previous_heartbeat):
                # The payload above was built before this write revealed the
                # conflict. Rewriting it inside the same transaction means the
                # row never lags a beat behind; the second upsert returns this
                # process's own row, so it never counts as a sighting.
                payload = msgspec.structs.replace(payload, name_conflict_at=self._name_conflict_at)
                await upsert_heartbeat(connection, self._heartbeat_write(payload, schema_revision))
        self._recent_starts = recent_starts

    def _sample_counters(self, at_monotonic: float) -> WindowCounts:
        ingestion_service = runtime.get_ingestion_service(self._app)
        if ingestion_service is None:
            return WindowCounts()
        readings = (
            (self._lines_counter, ingestion_service.parsed_lines),
            (self._failed_counter, ingestion_service.failed_records),
            (self._written_counter, ingestion_service.written_records),
            (self._failed_batches_counter, ingestion_service.failed_batches),
        )
        # The evaluator compares these counts, so a rebuilt service restarts
        # all of them together, even those whose new total is not lower.
        if ingestion_service is not self._counted_service or any(
            counter.restarted(total) for counter, total in readings
        ):
            for counter, _total in readings:
                counter.reset()
            self._counted_service = ingestion_service
        lines, failed_records, written_records, failed_batches = (
            counter.sample(at_monotonic, total) for counter, total in readings
        )
        return WindowCounts(
            lines=lines,
            failed_records=failed_records,
            written_records=written_records,
            failed_batches=failed_batches,
        )

    async def _merge_recent_starts(self, connection: AsyncConnection) -> list[datetime]:
        previous_heartbeat = await read_heartbeat(connection, self._instance_name)
        if previous_heartbeat is None:
            return [self._started_at]
        previous_payload = decode_payload(previous_heartbeat.payload)
        previous_starts = previous_payload.recent_starts if previous_payload is not None else []
        if previous_heartbeat.boot_id == self.boot_id and previous_starts:
            # An earlier write from this process committed but timed out
            # before it was recorded; its list already starts with this boot.
            return previous_starts[:RECENT_STARTS_KEPT]
        return [self._started_at, *previous_starts[: RECENT_STARTS_KEPT - 1]]

    def _track_conflict(
        self, at_monotonic: float, previous_heartbeat: PreviousHeartbeat | None
    ) -> bool:
        """Count foreign boot IDs; True when this beat set name_conflict_at."""
        foreign_boot_id = (
            previous_heartbeat.boot_id
            if previous_heartbeat is not None and previous_heartbeat.boot_id != self.boot_id
            else None
        )
        if foreign_boot_id is not None:
            self._foreign_sightings.append(at_monotonic)
        while (
            self._foreign_sightings
            and at_monotonic - self._foreign_sightings[0] > NAME_CONFLICT_WINDOW_SECONDS
        ):
            self._foreign_sightings.popleft()
        if len(self._foreign_sightings) < NAME_CONFLICT_THRESHOLD:
            self._conflict_logged = False
            return False
        if foreign_boot_id is None:
            return False
        self._name_conflict_at = datetime.now(timezone.utc)
        if not self._conflict_logged:
            self._conflict_logged = True
            logger.warning(
                "instance_name_conflict",
                instance_name=self._instance_name,
                boot_id=str(self.boot_id),
                foreign_boot_id=str(foreign_boot_id),
                sightings=len(self._foreign_sightings),
                window_seconds=NAME_CONFLICT_WINDOW_SECONDS,
            )
        return True

    def _heartbeat_write(self, payload: HeartbeatPayload, schema_revision: str) -> HeartbeatWrite:
        return HeartbeatWrite(
            instance_name=self._instance_name,
            boot_id=self.boot_id,
            mode=self._settings.app.mode,
            app_version=self._app_version,
            schema_revision=schema_revision,
            started_at=self._started_at,
            payload=msgspec.to_builtins(payload),
        )
