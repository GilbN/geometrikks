"""Log ingestion service - handles persistence via repositories.

This service orchestrates:
- Log parsing via LogParser
- Geographic data persistence via GeoLocationRepository and GeoEventRepository
- Access log persistence via AccessLogRepository
- Debug log persistence via AccessLogDebugRepository

All database operations go through repositories for consistency and testability.
Analytics aggregation is handled automatically by TimescaleDB continuous aggregates,

"""
from __future__ import annotations
import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from geoip2.database import Reader
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository
from geometrikks.domain.geo.utils import make_point
from geometrikks.services.logparser.schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES, GEOIP_LOCALES_DEFAULT
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.lib.utils import wait_for_path
from geometrikks.server.logging import get_logger


logger = get_logger(__name__)


@dataclass
class IngestionRepos:
    """The four repositories used by one flush cycle, all bound to the same session."""

    geo_location: GeoLocationRepository
    geo_event: GeoEventRepository
    access_log: AccessLogRepository
    access_log_debug: AccessLogDebugRepository

    @classmethod
    def from_session(cls, session: AsyncSession) -> "IngestionRepos":
        return cls(
            geo_location=GeoLocationRepository(session=session),
            geo_event=GeoEventRepository(session=session),
            access_log=AccessLogRepository(session=session),
            access_log_debug=AccessLogDebugRepository(session=session),
        )


def create_reader(path: Path|str, locales: list[str] | None = None) -> Reader|None:
    """Create a GeoIP2 Reader instance."""
    if any(loc not in ALLOWED_GEOIP_LOCALES for loc in locales or []):
        logger.warning(
            "Unmatched GeoIp2 locale found. Allowed are '%s', defaulting to 'en'",
            ALLOWED_GEOIP_LOCALES,
        )
        locales: list[str] = GEOIP_LOCALES_DEFAULT
    try:
        return Reader(path, locales=locales)
    except Exception:
        logger.exception("Failed to create GeoIP2 Reader for path: %s", path)
        return None

class LogIngestionService:
    """Orchestrates log parsing and persistence.

    Uses repositories for all database operations.
    Handles batching, caching, and background task lifecycle.

    Example:
        service = LogIngestionService(
            parsers=parsers,
            session_maker=session_maker,
        )
        await service.start()
        # ... later ...
        await service.stop()
    """

    def __init__(
        self,
        parsers: list["LogParser"],
        session_maker: Callable[[], AsyncSession],
        geoip_path: Path|str,
        locales: list[str] | None = None,
        *,
        repos_factory: Callable[[AsyncSession], IngestionRepos] = IngestionRepos.from_session,
        hostname: str = "localhost",
        batch_size: int = 100,
        commit_interval: float = 5.0,
        store_debug_lines: bool = False,
        queue_maxsize: int = 10_000,
    ) -> None:
        """Initialize the log ingestion service.

        Args:
            parsers: LogParser instances, one per tailed log file.
            session_maker: Callable producing a fresh AsyncSession per flush.
            geoip_path: Path|str, GeoIP2 database file path.
            locales: GeoIP2 locales to use for lookups.
            repos_factory: Builds the IngestionRepos bundle from a session.
            hostname: Hostname recorded on GeoEvent records.
            batch_size: Maximum records before forced commit.
            commit_interval: Maximum seconds between commits.
            store_debug_lines: If True, store all raw lines in debug table.
            queue_maxsize: Maximum size of the shared record queue.
        """
        self.parsers: list[LogParser] = parsers
        self.hostname: str = hostname
        self._session_maker = session_maker
        self._repos_factory = repos_factory
        self._batch: list[ParsedLogRecord] = []
        self.geoip_path: Path|str = geoip_path
        self.locales: list[str] | None = locales
        self.batch_size: int = batch_size
        self.commit_interval: int | float = commit_interval
        self.store_debug_lines: bool = store_debug_lines
        self._queue_maxsize: int = queue_maxsize

        # Live-feed fan-out: bounded queues, publish post-commit only.
        self._subscribers: set[asyncio.Queue[ParsedLogRecord]] = set()

        # In-memory cache: geohash -> committed (or pending-commit) GeoLocation id.
        # Ids cached since the last successful commit are tracked so a rollback
        # can evict them (their rows never landed -> FK poison otherwise).
        self._location_cache: dict[str, int] = {}
        self._uncommitted_geohashes: set[str] = set()
        self._cache_maxsize = 10_000

        # Background task management
        self._stop_event: asyncio.Event | None = None
        self._ingestion_task: asyncio.Task[None] | None = None
        self._queue: asyncio.Queue[ParsedLogRecord] | None = None
        self._tail_tasks: list[asyncio.Task[None]] = []
        self.is_running: bool = False

        # Statistics
        self.total_processed: int = 0
        self.total_geo_records: int = 0
        self.total_log_records: int = 0
        self.total_debug_records: int = 0

    @property
    def pending_records(self) -> int:
        """Records buffered in memory awaiting the next flush."""
        return len(self._batch)

    @property
    def is_task_running(self) -> bool:
        """Return True if ingestion task is running."""
        return self._ingestion_task is not None and not self._ingestion_task.done()

    async def start(self, *, skip_validation: bool = False) -> None:
        """Start one tail task per log file and the ingestion consumer."""
        if self.is_running:
            logger.warning("Ingestion already running")
            return

        if not (reader := create_reader(self.geoip_path, self.locales)):
            logger.error(
                "Cannot start ingestion: failed to create GeoIP2 reader with database at %s",
                self.geoip_path,
            )
            return

        # Set synchronously (before any `await`/task scheduling) so a second
        # start() called back-to-back sees is_running=True immediately; it
        # otherwise only flips inside _run_ingestion's task body, which hasn't
        # been scheduled yet when this call returns, letting two rapid start()
        # calls both pass the guard and spawn duplicate tail tasks + consumer.
        self.is_running = True

        self._stop_event = asyncio.Event()
        self._queue = asyncio.Queue(maxsize=self._queue_maxsize)

        self._tail_tasks = []
        for parser in self.parsers:
            parser.set_stop_event(self._stop_event)
            self._tail_tasks.append(
                asyncio.create_task(
                    self._tail_file(parser, reader, skip_validation),
                    name=f"log-tail:{parser.log_path}",
                )
            )

        self._ingestion_task = asyncio.create_task(
            self._run_ingestion(), name="log-ingestion"
        )
        logger.info(
            "Started log ingestion service (%d files, batch_size=%d, commit_interval=%.1fs)",
            len(self.parsers),
            self.batch_size,
            self.commit_interval,
        )

    async def _tail_file(self, parser: LogParser, reader: Reader, skip_validation: bool) -> None:
        """Tail a single log file, pushing parsed records onto the shared queue."""
        logger.debug("Waiting for log file: %s", parser.log_path)
        if not await wait_for_path(parser.log_path, timeout_seconds=60.0):
            logger.error("Skipping ingestion for missing log file: %s", parser.log_path)
            return
        assert self._queue is not None
        async for record in parser.iter_parsed_records(reader, skip_validation=skip_validation):
            if record is None:
                continue  # idle tick; the consumer handles interval commits via timeout
            await self._queue.put(record)

    async def stop(self, timeout: float = 10.0) -> None:
        """Stop the ingestion gracefully.

        Args:
            timeout: Seconds to wait before force-cancelling.
        """
        if not self._stop_event or not self._ingestion_task:
            return

        self._stop_event.set()

        if self._tail_tasks:
            _done, pending = await asyncio.wait(self._tail_tasks, timeout=timeout)
            for task in pending:
                logger.warning("Tail task %s did not stop gracefully, cancelling", task.get_name())
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

        try:
            await asyncio.wait_for(self._ingestion_task, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Ingestion did not stop gracefully, cancelling")
            self._ingestion_task.cancel()
            try:
                await self._ingestion_task
            except asyncio.CancelledError:
                pass
        except asyncio.CancelledError:
            pass
        finally:
            self.is_running = False

        logger.info(
            "Stopped log ingestion service. Total processed: %d", self.total_processed
        )

    async def _run_ingestion(self) -> None:
        """Consume parsed records from the shared queue, flushing batches to fresh sessions."""
        assert self._queue is not None and self._stop_event is not None
        last_commit: float = time.monotonic()
        try:
            while True:
                if (
                    self._stop_event.is_set()
                    and self._queue.empty()
                    and all(task.done() for task in self._tail_tasks)
                ):
                    break

                # Cap the wait so the loop re-checks the stop condition promptly;
                # otherwise stop() would block up to commit_interval or force-cancel.
                timeout = max(0.05, self.commit_interval - (time.monotonic() - last_commit))
                timeout = min(timeout, 0.25)
                try:
                    record = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                except asyncio.TimeoutError:
                    record = None

                if record is not None:
                    self._batch.append(record)

                now = time.monotonic()
                if len(self._batch) >= self.batch_size or (
                    self._batch and (now - last_commit) >= self.commit_interval
                ):
                    await self._flush_batch()
                    last_commit = now

        except asyncio.CancelledError:
            logger.info("Ingestion cancelled")
            raise
        except Exception as e:
            logger.exception("Ingestion loop error: %s", e)
            raise
        finally:
            if self._batch:
                try:
                    await self._flush_batch()
                except Exception as e:
                    logger.exception("Final flush failed: %s", e)
            self.is_running = False

    async def _process_record(self, record: ParsedLogRecord, repos: IngestionRepos, flushed: dict[str, int]) -> None:
        """Process a single parsed record within the current flush session."""
        access_log_model: AccessLog | None = None

        if record.geo_data and record.ip_address:
            location_id: int | None = await self._get_or_create_location(record.geo_data, repos)
            if location_id is not None:
                geo_event = GeoEvent(
                    timestamp=record.geo_data.timestamp,
                    ip_address=record.ip_address,
                    hostname=self.hostname,
                    location_id=location_id,
                )
                # Plain session.add: repo.add() flushes + refreshes per call
                # (2 DB round trips per record), which caps throughput at a few
                # hundred records/s. Deferring to the batch commit lets
                # SQLAlchemy bulk-insert the whole batch (insertmanyvalues).
                repos.geo_event.session.add(geo_event)
                self.total_geo_records += 1
                flushed["geo"] += 1

        if record.access_log:
            access_log_model = self._to_access_log_model(record.access_log)
            repos.access_log.session.add(access_log_model)
            self.total_log_records += 1
            flushed["log"] += 1

        if self.store_debug_lines or record.is_malformed:
            await self._create_debug_entry(record, access_log_model, repos)
            self.total_debug_records += 1
            flushed["debug"] += 1

        self.total_processed += 1

    async def _get_or_create_location(self, geo_data: ParsedGeoData, repos: IngestionRepos) -> int | None:
        """Return the GeoLocation id for this geohash, creating the row if needed."""
        if (cached_id := self._location_cache.get(geo_data.geohash)) is not None:
            return cached_id

        if len(self._location_cache) >= self._cache_maxsize:
            evicted = next(iter(self._location_cache))
            self._location_cache.pop(evicted)
            self._uncommitted_geohashes.discard(evicted)

        if existing := await repos.geo_location.get_by_geohash(geo_data.geohash):
            self._location_cache[geo_data.geohash] = existing.id
            return existing.id

        location = GeoLocation(
            geohash=geo_data.geohash,
            latitude=geo_data.latitude,
            longitude=geo_data.longitude,
            country_code=geo_data.country_code,
            country_name=geo_data.country_name,
            state=geo_data.state,
            state_code=geo_data.state_code,
            city=geo_data.city,
            postal_code=geo_data.postal_code,
            timezone=geo_data.timezone,
            geographic_point=make_point(geo_data.latitude, geo_data.longitude),
        )
        # session.add + one flush to get the id; repo.add() would add a
        # redundant refresh round trip. Fires only for geohashes not in cache.
        repos.geo_location.session.add(location)
        await repos.geo_location.session.flush()

        self._location_cache[geo_data.geohash] = location.id
        self._uncommitted_geohashes.add(geo_data.geohash)
        return location.id

    def _evict_uncommitted_locations(self) -> None:
        """Drop cache entries whose inserts were rolled back before committing."""
        for geohash in self._uncommitted_geohashes:
            self._location_cache.pop(geohash, None)
        self._uncommitted_geohashes.clear()

    def _sanitize_for_postgres(self, value: str | None) -> str | None:
        """Remove null bytes from strings for PostgreSQL compatibility.

        PostgreSQL text/varchar columns cannot contain null bytes (0x00).
        This sanitizes strings that may contain binary garbage from attack probes.
        """
        if value is None:
            return None
        # Replace null bytes with unicode replacement character for visibility
        return value.replace('\x00', '\ufffd')

    async def _create_debug_entry(self, record: ParsedLogRecord, access_log: AccessLog | None, repos: IngestionRepos) -> None:
        """Create AccessLogDebug entry for debugging/malformed requests."""
        if not record.raw_line:
            return

        # Flush to get access_log.id if we have one
        if access_log:
            await repos.access_log.session.flush()

        # Sanitize raw_line - PostgreSQL cannot store null bytes in text columns
        sanitized_line = self._sanitize_for_postgres(record.raw_line)
        sanitized_error = self._sanitize_for_postgres(record.parse_error)

        debug_entry = AccessLogDebug(
            access_log_id=access_log.id if access_log else None,
            raw_line=sanitized_line,
            is_malformed=record.is_malformed,
            parse_error=sanitized_error,
            # Denormalized so the debug list never joins the access_logs
            # hypertable. Every value is already on the object we were handed.
            log_timestamp=access_log.timestamp if access_log else None,
            ip_address=str(access_log.ip_address) if access_log else None,
            method=access_log.method if access_log else None,
            url=access_log.url if access_log else None,
            host=access_log.host if access_log else None,
            status_code=access_log.status_code if access_log else None,
            country_code=access_log.country_code if access_log else None,
            country_name=access_log.country_name if access_log else None,
            city=access_log.city if access_log else None,
            user_agent=access_log.user_agent if access_log else None,
        )
        repos.access_log_debug.session.add(debug_entry)

    async def _flush_batch(self) -> None:
        """Write the buffered batch in one fresh session: open -> repos -> flush -> commit -> close.

        Inserts are deferred to the commit (bulk INSERT via insertmanyvalues),
        so row-level DB errors surface there and discard the whole batch via
        the commit-failure path. The per-record path still catches errors from
        location get-or-create (which flushes) and record conversion; such a
        failure rolls back the session (discarding earlier records in this
        batch) and processing continues.
        """
        if not self._batch:
            return
        batch, self._batch = self._batch, []
        flushed = {"geo": 0, "log": 0, "debug": 0}
        # Records that processed without raising; only these are published
        # post-commit. A per-record failure rolls back earlier records of this
        # batch (matching existing semantics), so reset the list on failure too.
        committed_candidates: list[ParsedLogRecord] = []

        async with self._session_maker() as session:
            repos = self._repos_factory(session)
            for record in batch:
                try:
                    await self._process_record(record, repos, flushed)
                    committed_candidates.append(record)
                except Exception as e:
                    logger.error(
                        "Failed to process record (rolling back batch): %s - raw_line preview: %.100s",
                        e,
                        record.raw_line[:100] if record.raw_line else "N/A",
                    )
                    committed_candidates = []
                    try:
                        await session.rollback()
                    except Exception as rollback_err:
                        logger.error("Rollback failed: %s", rollback_err)
                    self._evict_uncommitted_locations()
                    # The failing record may have hit a poisoned cache entry
                    # (an id cached before this service run whose row does not
                    # exist, e.g. after a crashed commit). Uncommitted-tracking
                    # can't see those, so drop the record's own geohash too.
                    if record.geo_data:
                        self._location_cache.pop(record.geo_data.geohash, None)

            try:
                await session.commit()
                self._uncommitted_geohashes.clear()
                self._publish(committed_candidates)
            except Exception as e:
                logger.error("Batch commit failed (rolling back): %s", e)
                await session.rollback()
                self._evict_uncommitted_locations()
                # Same poisoned-entry hazard as above, but here we don't know
                # which record broke the commit — evict every geohash the
                # batch touched so the next flush re-resolves them from the DB.
                for record in batch:
                    if record.geo_data:
                        self._location_cache.pop(record.geo_data.geohash, None)

        logger.debug(
            "Committed batch of %d records. (Geo: %d | Log: %d | Debug: %d)",
            len(batch),
            flushed["geo"],
            flushed["log"],
            flushed["debug"],
        )

    async def flush_records(self, records: list[ParsedLogRecord]) -> None:
        """Ingest externally produced records through the batch machinery.

        Used by the batch importer. Runs the same _flush_batch path as live
        tailing: fresh session, location cache, rollback-and-evict recovery.
        """
        self._batch.extend(records)
        await self._flush_batch()

    def subscribe(self, maxsize: int = 1000) -> asyncio.Queue[ParsedLogRecord]:
        """Register a live-feed subscriber. Caller must unsubscribe()."""
        queue: asyncio.Queue[ParsedLogRecord] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[ParsedLogRecord]) -> None:
        self._subscribers.discard(queue)

    def _publish(self, records: list[ParsedLogRecord]) -> None:
        """Fan committed records out to subscribers; drop oldest when full.

        Never blocks and never raises: a slow browser must not backpressure
        ingestion.
        """
        for queue in self._subscribers:
            for record in records:
                try:
                    queue.put_nowait(record)
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                        queue.put_nowait(record)
                    except (asyncio.QueueEmpty, asyncio.QueueFull):
                        pass

    def _to_access_log_model(self, parsed: ParsedAccessLog) -> AccessLog:
        """Convert ParsedAccessLog schema to ORM model."""
        return AccessLog(
            timestamp=parsed.timestamp,
            ip_address=parsed.ip_address,
            remote_user=parsed.remote_user,
            method=parsed.method,
            url=parsed.url,
            http_version=parsed.http_version,
            status_code=parsed.status_code,
            bytes_sent=parsed.bytes_sent,
            referrer=parsed.referrer,
            user_agent=parsed.user_agent,
            request_time=parsed.request_time,
            upstream_response_time=parsed.upstream_response_time,
            host=parsed.host,
            country_code=parsed.country_code,
            country_name=parsed.country_name,
            city=parsed.city,
        )

    # Statistics properties for API endpoints
    @property
    def parsed_lines(self) -> int:
        """Total parsed lines across all tailed files."""
        return sum(parser.parsed_lines for parser in self.parsers)

    @property
    def skipped_lines(self) -> int:
        """Total skipped lines across all tailed files."""
        return sum(parser.skipped_lines for parser in self.parsers)
