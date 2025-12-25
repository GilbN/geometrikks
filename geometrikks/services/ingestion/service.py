"""Log ingestion service - handles persistence via repositories.

This service orchestrates:
- Log parsing via LogParser
- Geographic data persistence via GeoLocationRepository and GeoEventRepository
- Access log persistence via AccessLogRepository
- Debug log persistence via AccessLogDebugRepository

All database operations go through repositories for consistency and testability.
"""
from __future__ import annotations
import os
import logging
import asyncio
from asyncio import Task
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from pathlib import Path

from geoip2.database import Reader

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.domain.geo.utils import make_point
from geometrikks.domain.analytics.repositories import BatchMetrics
from geometrikks.services.logparser.schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES, GEOIP_LOCALES_DEFAULT
from geometrikks.services.logparser.logparser import LogParser, wait

if TYPE_CHECKING:
    from geometrikks.domain.geo.repositories import GeoLocationRepository, GeoEventRepository
    from geometrikks.domain.logs.repositories import AccessLogRepository, AccessLogDebugRepository
    from geometrikks.services.aggregation.service import AggregationService


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
            parser=parser,
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
        parser: "LogParser",
        geo_location_repo: "GeoLocationRepository",
        geo_event_repo: "GeoEventRepository",
        access_log_repo: "AccessLogRepository",
        access_log_debug_repo: "AccessLogDebugRepository",
        geoip_path: Path|str,
        locales: list[str] | None = None,
        *,
        batch_size: int = 100,
        commit_interval: float = 5.0,
        store_debug_lines: bool = False,
        aggregation_service: "AggregationService | None" = None,
    ) -> None:
        """Initialize the log ingestion service.

        Args:
            parser: LogParser instance for parsing log lines.
            geo_location_repo: Repository for GeoLocation model.
            geo_event_repo: Repository for GeoEvent model.
            access_log_repo: Repository for AccessLog model.
            access_log_debug_repo: Repository for AccessLogDebug model.
            geoip_path: Path|str, GeoIP2 database file path.
            batch_size: Maximum records before forced commit.
            commit_interval: Maximum seconds between commits.
            store_debug_lines: If True, store all raw lines in debug table.
            aggregation_service: Optional service for real-time analytics aggregation.
        """
        self.parser: LogParser = parser
        self.geo_location_repo: GeoLocationRepository = geo_location_repo
        self.geo_event_repo: GeoEventRepository = geo_event_repo
        self.access_log_repo: AccessLogRepository = access_log_repo
        self.access_log_debug_repo: AccessLogDebugRepository = access_log_debug_repo
        self.aggregation_service: AggregationService | None = aggregation_service
        self.geoip_path: Path|str = geoip_path
        self.locales: list[str] = locales
        self.batch_size: int = batch_size
        self.commit_interval: int | float = commit_interval
        self.store_debug_lines: bool = store_debug_lines

        # In-memory cache for GeoLocation by geohash
        self._location_cache: dict[str, GeoLocation] = {}
        self._cache_maxsize = 10_000

        # Background task management
        self._stop_event: asyncio.Event | None = None
        self._ingestion_task: asyncio.Task[None] | None = None

        # Statistics
        self.pending_records: int = 0
        self.pending_geo_records: int = 0
        self.pending_log_records: int = 0
        self.pending_log_debug_records: int = 0

        self.total_processed: int = 0
        self.total_geo_records: int = 0
        self.total_log_records: int = 0
        self.total_debug_records: int = 0

        # Batch metrics for aggregation (reset on each commit)
        self._reset_batch_metrics()
        self._batch_metrics: BatchMetrics
    
    def _reset_batch_metrics(self) -> None:
        """Reset batch metrics for a new batch."""
        self._batch_metrics = BatchMetrics(
            timestamp=datetime.now(timezone.utc),
            unique_ips=set(),
            unique_countries=set(),
        )

    @property
    def is_running(self) -> bool:
        """Return True if ingestion task is running."""
        return self._ingestion_task is not None and not self._ingestion_task.done()

    @wait(timeout_seconds=60)
    def log_file_exists(self, log_path: Path) -> bool:
        """Try for 60 seconds to check if the log file exists."""
        logger.debug(f"Checking if log file {log_path} exists.")
        if not os.path.exists(log_path):
            logger.warning(f"Log file {log_path} does not exist.")
            return False
        logger.info(f"Log file {log_path} exists.")
        return True

    @wait(timeout_seconds=5)
    def geoip_file_exists(self, geoip_path: Path) -> bool:
        """Try for 60 seconds to check if the GeoIP file exists."""
        logger.debug(f"Checking if GeoIP file {geoip_path} exists.")
        if not os.path.exists(geoip_path):
            logger.warning(f"GeoIP file {geoip_path} does not exist.")
            return False
        logger.info(f"GeoIP file {geoip_path} exists.")
        return True

    async def start(self, *, skip_validation: bool = False) -> None:
        """Start the ingestion background task.

        Args:
            skip_validation: Skip initial log format validation.
        """
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
        self.parser.set_stop_event(self._stop_event)

        self._ingestion_task: Task[None] = asyncio.create_task(
            self._run_ingestion(reader=reader, skip_validation=skip_validation),
            name="log-ingestion",
        )
        logger.info(
            "Started log ingestion service (batch_size=%d, commit_interval=%.1fs)",
            self.batch_size,
            self.commit_interval,
        )

    async def stop(self, timeout: float = 10.0) -> None:
        """Stop the ingestion gracefully.

        Args:
            timeout: Seconds to wait before force-cancelling.
        """
        if not self._stop_event or not self._ingestion_task:
            return

        self._stop_event.set()
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

        logger.info(
            "Stopped log ingestion service. Total processed: %d", self.total_processed
        )

    async def _run_ingestion(self, *, reader:Reader, skip_validation: bool) -> None:
        """Core ingestion loop."""
        last_commit: int | float = time.monotonic()
        # Validate files exist
        if not await asyncio.to_thread(self.log_file_exists, self.parser.log_path):
            logger.error(
                "Cannot start ingestion: log file does not exist at %s",
                self.parser.log_path,
            )
            return
        try:
            async for record in self.parser.iter_parsed_records(reader, skip_validation=skip_validation):
                if self._stop_event and self._stop_event.is_set():
                    break

                # Check for interval-based commit
                now: int | float = time.monotonic()
                if (
                    self.pending_records > 0
                    and (now - last_commit) >= self.commit_interval
                ):
                    await self._commit_batch()
                    last_commit: int | float = now

                # None = idle tick
                if record is None:
                    continue

                # Process the record
                await self._process_record(record)

                # Check for batch-size commit
                if self.pending_records >= self.batch_size:
                    await self._commit_batch()
                    last_commit: int | float = time.monotonic()

        except asyncio.CancelledError:
            logger.info("Ingestion cancelled")
            raise
        except Exception as e:
            logger.exception("Ingestion loop error: %s", e)
            raise
        finally:
            # Final commit
            if self.pending_records > 0:
                try:
                    await self._commit_batch()
                except Exception as e:
                    logger.exception("Final commit failed: %s", e)

    async def _process_record(self, record: ParsedLogRecord) -> None:
        """Process a single parsed record."""
        access_log_model: AccessLog | None = None

        if record.geo_data and record.geo_data.timestamp:
            if self._batch_metrics.is_after_truncated_hour(record.geo_data.timestamp):
                await self._commit_batch() # New hour - commit what we have first so the hourly truncated stats are correct
            self._batch_metrics.update_truncated_hour(record.geo_data.timestamp) # Update current batch hour
        
        # Handle geo data
        if record.geo_data and record.ip_address:
            location: GeoLocation | None = await self._get_or_create_location(record.geo_data)
            if location:
                geo_event = GeoEvent(
                    timestamp=record.geo_data.timestamp,
                    ip_address=record.ip_address,
                    hostname=self.parser.hostname,
                    location_id=location.id,
                )
                await self.geo_event_repo.add(geo_event, auto_commit=False)
                self.pending_records += 1
                self.total_geo_records += 1
                self.pending_geo_records += 1

                # Track geo event metrics for aggregation
                self._batch_metrics.geo_events += 1
                if record.ip_address and self._batch_metrics.unique_ips is not None:
                    self._batch_metrics.unique_ips.add(record.ip_address)
                if record.geo_data.country_code and self._batch_metrics.unique_countries is not None:
                    self._batch_metrics.unique_countries.add(record.geo_data.country_code)

        # Handle access log
        if record.access_log:
            access_log_model: AccessLog = self._to_access_log_model(record.access_log)
            await self.access_log_repo.add(access_log_model, auto_commit=False)
            self.pending_records += 1
            self.total_log_records += 1
            self.pending_log_records += 1

            # Track access log metrics for aggregation
            self._batch_metrics.requests += 1
            self._batch_metrics.bytes_sent += record.access_log.bytes_sent
            self._batch_metrics.total_request_time += record.access_log.request_time
            if record.access_log.request_time > self._batch_metrics.max_request_time:
                self._batch_metrics.max_request_time = record.access_log.request_time

            # Track status codes
            status: int = record.access_log.status_code
            if 200 <= status < 300:
                self._batch_metrics.status_2xx += 1
            elif 300 <= status < 400:
                self._batch_metrics.status_3xx += 1
            elif 400 <= status < 500:
                self._batch_metrics.status_4xx += 1
            elif status >= 500:
                self._batch_metrics.status_5xx += 1

        # Handle debug log (if enabled or malformed)
        if self.store_debug_lines or record.is_malformed:
            await self._create_debug_entry(record, access_log_model)
            self.total_debug_records += 1
            self.pending_log_debug_records += 1

        # Track malformed requests
        if record.is_malformed:
            self._batch_metrics.malformed_requests += 1

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

    async def _create_debug_entry(self, record: ParsedLogRecord, access_log: AccessLog | None) -> None:
        """Create AccessLogDebug entry for debugging/malformed requests."""
        if not record.raw_line:
            return

        # Flush to get access_log.id if we have one
        if access_log:
            await self.access_log_repo.session.flush()

        debug_entry = AccessLogDebug(
            access_log_id=access_log.id if access_log else None,
            raw_line=record.raw_line,
            is_malformed=record.is_malformed,
            parse_error=record.parse_error,
        )
        await self.access_log_debug_repo.add(debug_entry, auto_commit=False)
        self.pending_records += 1

    async def _commit_batch(self) -> None:
        """Commit pending records and update analytics.

        All repositories share the same session, so we only need to commit once.
        After commit, updates hourly stats via aggregation service if available.
        """
        await self.geo_location_repo.session.commit()
        logger.debug(
            "Committed %d records. (Geo Records: %s | Log Records: %s | Log Debug Records: %s)",
            self.pending_records,
            self.pending_geo_records,
            self.pending_log_records,
            self.pending_log_debug_records,
        )

        # Update hourly stats via aggregation service
        if self.aggregation_service and (
            self._batch_metrics.requests > 0 or self._batch_metrics.geo_events > 0
        ):
            await self.aggregation_service.increment_hourly_stats(self._batch_metrics)

        # Reset counters
        self.pending_records = 0
        self.pending_geo_records = 0
        self.pending_log_records = 0
        self.pending_log_debug_records = 0
        self._reset_batch_metrics()

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
            connect_time=parsed.connect_time,
            host=parsed.host,
            country_code=parsed.country_code,
            country_name=parsed.country_name,
            city=parsed.city,
        )

    # Statistics properties for API endpoints
    @property
    def parsed_lines(self) -> int:
        """Return the number of parsed lines from the parser."""
        return self.parser.parsed_lines

    @property
    def skipped_lines(self) -> int:
        """Return the number of skipped lines from the parser."""
        return self.parser.skipped_lines
