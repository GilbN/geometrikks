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
import logging
import asyncio
import time
from typing import TYPE_CHECKING
from pathlib import Path

from geoip2.database import Reader

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.domain.geo.utils import make_point
from geometrikks.services.logparser.schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES, GEOIP_LOCALES_DEFAULT
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.lib.utils import wait_for_path

if TYPE_CHECKING:
    from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
    from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository


logger = logging.getLogger(__name__)


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
            geo_location_repo=geo_location_repo,
            geo_event_repo=geo_event_repo,
            access_log_repo=access_log_repo,
            access_log_debug_repo=access_log_debug_repo,
        )
        await service.start()
        # ... later ...
        await service.stop()
    """

    def __init__(
        self,
        parsers: list["LogParser"],
        geo_location_repo: "GeoLocationRepository",
        geo_event_repo: "GeoEventRepository",
        access_log_repo: "AccessLogRepository",
        access_log_debug_repo: "AccessLogDebugRepository",
        geoip_path: Path|str,
        locales: list[str] | None = None,
        *,
        hostname: str = "localhost",
        batch_size: int = 100,
        commit_interval: float = 5.0,
        store_debug_lines: bool = False,
        queue_maxsize: int = 10_000,
    ) -> None:
        """Initialize the log ingestion service.

        Args:
            parsers: LogParser instances, one per tailed log file.
            geo_location_repo: Repository for GeoLocation model.
            geo_event_repo: Repository for GeoEvent model.
            access_log_repo: Repository for AccessLog model.
            access_log_debug_repo: Repository for AccessLogDebug model.
            geoip_path: Path|str, GeoIP2 database file path.
            hostname: Hostname recorded on GeoEvent records.
            batch_size: Maximum records before forced commit.
            commit_interval: Maximum seconds between commits.
            store_debug_lines: If True, store all raw lines in debug table.
            queue_maxsize: Maximum size of the shared record queue.
        """
        self.parsers: list[LogParser] = parsers
        self.hostname: str = hostname
        self.geo_location_repo: GeoLocationRepository = geo_location_repo
        self.geo_event_repo: GeoEventRepository = geo_event_repo
        self.access_log_repo: AccessLogRepository = access_log_repo
        self.access_log_debug_repo: AccessLogDebugRepository = access_log_debug_repo
        self.geoip_path: Path|str = geoip_path
        self.locales: list[str] = locales
        self.batch_size: int = batch_size
        self.commit_interval: int | float = commit_interval
        self.store_debug_lines: bool = store_debug_lines
        self._queue_maxsize: int = queue_maxsize

        # In-memory cache for GeoLocation by geohash
        self._location_cache: dict[str, GeoLocation] = {}
        self._cache_maxsize = 10_000

        # Background task management
        self._stop_event: asyncio.Event | None = None
        self._ingestion_task: asyncio.Task[None] | None = None
        self._queue: asyncio.Queue[ParsedLogRecord] | None = None
        self._tail_tasks: list[asyncio.Task[None]] = []
        self.is_running: bool = False

        # Statistics
        self.pending_records: int = 0
        self.pending_geo_records: int = 0
        self.pending_log_records: int = 0
        self.pending_log_debug_records: int = 0

        self.total_processed: int = 0
        self.total_geo_records: int = 0
        self.total_log_records: int = 0
        self.total_debug_records: int = 0

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
        """Consume parsed records from the shared queue, committing in batches."""
        assert self._queue is not None and self._stop_event is not None
        last_commit: float = time.monotonic()
        self.is_running = True
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
                    try:
                        await self._process_record(record)
                    except Exception as e:
                        logger.error(
                            "Failed to process record (rolling back): %s - raw_line preview: %.100s",
                            e,
                            record.raw_line[:100] if record.raw_line else "N/A",
                        )
                        try:
                            await self.geo_location_repo.session.rollback()
                            self.pending_records = 0
                            self.pending_geo_records = 0
                            self.pending_log_records = 0
                            self.pending_log_debug_records = 0
                        except Exception as rollback_err:
                            logger.error("Rollback failed: %s", rollback_err)
                        continue

                now = time.monotonic()
                if self.pending_records >= self.batch_size or (
                    self.pending_records > 0 and (now - last_commit) >= self.commit_interval
                ):
                    await self._commit_batch()
                    last_commit = now

        except asyncio.CancelledError:
            logger.info("Ingestion cancelled")
            raise
        except Exception as e:
            logger.exception("Ingestion loop error: %s", e)
            raise
        finally:
            if self.pending_records > 0:
                try:
                    await self._commit_batch()
                except Exception as e:
                    logger.exception("Final commit failed: %s", e)
            self.is_running = False

    async def _process_record(self, record: ParsedLogRecord) -> None:
        """Process a single parsed record."""
        access_log_model: AccessLog | None = None

        # Handle geo data
        if record.geo_data and record.ip_address:
            location: GeoLocation | None = await self._get_or_create_location(record.geo_data)
            if location:
                geo_event = GeoEvent(
                    timestamp=record.geo_data.timestamp,
                    ip_address=record.ip_address,
                    hostname=self.hostname,
                    location_id=location.id,
                )
                await self.geo_event_repo.add(geo_event, auto_commit=False)
                self.pending_records += 1
                self.total_geo_records += 1
                self.pending_geo_records += 1

        # Handle access log
        if record.access_log:
            access_log_model: AccessLog = self._to_access_log_model(record.access_log)
            await self.access_log_repo.add(access_log_model, auto_commit=False)
            self.pending_records += 1
            self.total_log_records += 1
            self.pending_log_records += 1

        # Handle debug log (if enabled or malformed)
        if self.store_debug_lines or record.is_malformed:
            await self._create_debug_entry(record, access_log_model)
            self.total_debug_records += 1
            self.pending_log_debug_records += 1

        self.total_processed += 1

    async def _get_or_create_location(self, geo_data: ParsedGeoData) -> GeoLocation | None:
        """Get existing or create new GeoLocation using repository."""
        # Check cache first
        if cached := self._location_cache.get(geo_data.geohash):
            return cached

        # Evict oldest if cache full
        if len(self._location_cache) >= self._cache_maxsize:
            self._location_cache.pop(next(iter(self._location_cache)))

        # Check database via repository
        if existing := await self.geo_location_repo.get_by_geohash(geo_data.geohash):
            self._location_cache[geo_data.geohash] = existing
            return existing

        # Create new location
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
            geographic_point=make_point(geo_data.latitude, geo_data.longitude)
        )

        # Add and flush to get ID
        location: GeoLocation = await self.geo_location_repo.add(location, auto_commit=False)
        await self.geo_location_repo.session.flush()

        self._location_cache[geo_data.geohash] = location
        return location

    def _sanitize_for_postgres(self, value: str | None) -> str | None:
        """Remove null bytes from strings for PostgreSQL compatibility.

        PostgreSQL text/varchar columns cannot contain null bytes (0x00).
        This sanitizes strings that may contain binary garbage from attack probes.
        """
        if value is None:
            return None
        # Replace null bytes with unicode replacement character for visibility
        return value.replace('\x00', '\ufffd')

    async def _create_debug_entry(self, record: ParsedLogRecord, access_log: AccessLog | None) -> None:
        """Create AccessLogDebug entry for debugging/malformed requests."""
        if not record.raw_line:
            return

        # Flush to get access_log.id if we have one
        if access_log:
            await self.access_log_repo.session.flush()

        # Sanitize raw_line - PostgreSQL cannot store null bytes in text columns
        sanitized_line = self._sanitize_for_postgres(record.raw_line)
        sanitized_error = self._sanitize_for_postgres(record.parse_error)

        debug_entry = AccessLogDebug(
            access_log_id=access_log.id if access_log else None,
            raw_line=sanitized_line,
            is_malformed=record.is_malformed,
            parse_error=sanitized_error,
        )
        await self.access_log_debug_repo.add(debug_entry, auto_commit=False)
        self.pending_records += 1

    async def _commit_batch(self) -> None:
        """Commit pending records.

        All repositories share the same session, so we only need to commit once.
        Analytics aggregation handled by TimescaleDB continuous aggregates.
        """
        await self.geo_location_repo.session.commit()
        logger.debug(
            "Committed %d records. (Geo Records: %s | Log Records: %s | Log Debug Records: %s)",
            self.pending_records,
            self.pending_geo_records,
            self.pending_log_records,
            self.pending_log_debug_records,
        )

        # Reset counters
        self.pending_records = 0
        self.pending_geo_records = 0
        self.pending_log_records = 0
        self.pending_log_debug_records = 0

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
