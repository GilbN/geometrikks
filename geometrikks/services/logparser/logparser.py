"""Log parser module for tailing and ingesting nginx access logs."""
from collections.abc import AsyncGenerator
import re
import os
import time
import logging
import asyncio
from functools import wraps, lru_cache
from datetime import datetime, timezone
import contextlib
from pathlib import Path
from typing import Any, ParamSpec, Callable

import aiofiles.os
from geoip2.database import Reader
from geoip2.models import City
from geohash2 import encode
from IPy import IP
from sqlalchemy.ext.asyncio import AsyncSession

from .constants import (
    ipv4_pattern,
    ipv6_pattern,
    MONITORED_IP_TYPES,
    ipv4,
    ipv6,
    ALLOWED_GEOIP_LOCALES,
    GEOIP_LOCALES_DEFAULT,
)
from .dataclasses import ParsedOrmRecord
from geometrikks.domain import AccessLog, AccessLogDebug, GeoEvent, GeoLocation


logger = logging.getLogger(__name__)

P = ParamSpec("P")

def wait(timeout_seconds: int = 60) -> Callable[[Callable[P, bool]], Callable[P, bool]]:
    """Factory Decorator to wait for a function to return True for a given amount of time.

    Args:
        timeout_seconds (int, optional): Defaults to 60.
    """
    def decorator(func: Callable[P, bool]) -> Callable[P, bool]:
        @wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> bool:
            # Allow tests to bypass retry loops
            if os.getenv("DISABLE_WAIT", "false").lower() == "true":
                return bool(func(*args, **kwargs))
            timeout: float = time.time() + timeout_seconds
            while time.time() < timeout:
                if func(*args, **kwargs):
                    return True
                time.sleep(1)
            logger.error(f"Timeout of {timeout_seconds} seconds reached on {func.__name__} function.")
            return False
        return wrapper
    return decorator

class LogParser:
    def __init__(self,
                 log_path:Path,
                 geoip_path:Path,
                 geoip_locales: list[str],
                 send_logs: bool = False,
                 poll_interval: float = 1.0,
                 host_name: str = "localhost",
                 store_debug_lines: bool = False,
                 ) -> None:
        """I'm here to parse ass and kick logs, and I'm all out of logs...

        Args:
            log_path (Path): The path to the log file.
            geoip_path (Path): The path the the GeoLite mmdb file.
            geoip_locales (list[str]): List of locales (en,de,it etc)
            send_logs (bool, optional): If True, send access log data to db. Defaults to False.
            poll_interval (float, optional): How often to check for new log lines. Defaults to 1.0.
            store_debug_lines (bool, optional): Store raw log lines in AccessLogDebug table. Defaults to False.
        """
        
        
        self.log_path = log_path
        self.geoip_path = geoip_path
        self.geoip_locales = geoip_locales
        self.send_logs = send_logs
        self.poll_interval = poll_interval

        if any(loc not in ALLOWED_GEOIP_LOCALES for loc in geoip_locales):
            logger.warning("Unmatched GeoIp2 locale found. Allowed are '%s', defaulting to 'en'", ALLOWED_GEOIP_LOCALES)
            self.geoip_locales = GEOIP_LOCALES_DEFAULT
        
        self.hostname: str = host_name
        self.store_debug_lines: bool = store_debug_lines
        self.geoip_reader = Reader(self.geoip_path)
        self.current_log_inode: int|None = None
        self.parsed_lines: int = 0
        self.pending_lines: int = 0
        self.skipped_lines: int = 0

        # Async task and stop event
        self._stop_event: asyncio.Event | None = None
        self._ingestion_task: asyncio.Task[None] | None = None
        
        # Simple in-memory cache for GeoLocation by geohash
        self._geolocation_cache: dict[str, GeoLocation] = {}
        self._cache_maxsize = 10_000

        logger.debug("Log file path: %s", self.log_path)
        logger.debug("GeoIP database path: %s", self.geoip_path)
        logger.debug("Send NGINX logs: %s", self.send_logs)
        logger.debug("Store debug lines: %s", self.store_debug_lines)
        logger.debug("Hostname: %s", self.hostname)
    
    def parsed_lines_count(self) -> int:
        """Return the number of parsed lines."""
        return self.parsed_lines

    def skipped_lines_count(self) -> int:
        """Return the number of skipped lines."""
        return self.skipped_lines

    @lru_cache(maxsize=1024)
    def validate_log_line(self, log_line: str) -> re.Match[str] | None:
        """Validate the log line against the IPv4 and IPv6 patterns."""
        if self.send_logs:
            return ipv4_pattern().match(log_line) or ipv6_pattern().match(log_line)
        # If we are not sending logs but only geo data, only validate the IP address
        self.send_logs = False
        return ipv4().match(log_line) or ipv6().match(log_line)

    @wait(timeout_seconds=60)
    def validate_log_format(self) -> bool: # regex tester
        """Try for 60 seconds and validate that the log format is correct by checking the last 3 lines."""
        LAST_LINE_COUNT = 3
        position = LAST_LINE_COUNT + 1
        log_lines_capture: list[str]  = []
        lines = []
        with open(self.log_path, "r", encoding="utf-8") as f:
            while len(log_lines_capture) <= LAST_LINE_COUNT:
                try:
                    f.seek(-position, os.SEEK_END) # Move to the last line
                except (IOError, OSError):
                    f.seek(os.SEEK_SET) # Start of file
                    break
                finally:
                    log_lines_capture = list(f) # Read all lines from the current position
                position *= 2 # Double the position to read more lines
        lines = log_lines_capture[-LAST_LINE_COUNT:] # Get the last 3 lines
        for line in lines:
            if self.validate_log_line(line):
                logger.info("Log file format is valid!")
                return True
        logger.debug("Testing log format")
        return False

    @wait(timeout_seconds=60)
    def log_file_exists(self) -> bool:
        """Try for 60 seconds to check if the log file exists."""
        logger.debug(f"Checking if log file {self.log_path} exists.")
        if not os.path.exists(self.log_path):
            logger.warning(f"Log file {self.log_path} does not exist.")
            return False
        logger.info(f"Log file {self.log_path} exists.")
        self.current_log_inode = os.stat(self.log_path).st_ino
        return True

    @wait(timeout_seconds=60)
    def geoip_file_exists(self) -> bool:
        """Try for 60 seconds to check if the GeoIP file exists."""
        logger.debug(f"Checking if GeoIP file {self.geoip_path} exists.")
        if not os.path.exists(self.geoip_path):
            logger.warning(f"GeoIP file {self.geoip_path} does not exist.")
            return False
        logger.info(f"GeoIP file {self.geoip_path} exists.")
        return True
    

    async def _is_rotated_async(self, prev_stat: os.stat_result) -> bool:
        """Check if the log file was rotated.

        Detects rotation via:
        - Inode change (file replaced)
        - Size decrease of >=99% (file truncated)
        """
        if os.getenv("DISABLE_ROTATION_CHECK", "false").lower() == "true":
            return False
        try:
            new_stat = await aiofiles.os.stat(self.log_path)
        except OSError as e:
            logger.warning("Could not stat log file: %s", e)
            return False

        # Inode changed
        if new_stat.st_ino != prev_stat.st_ino:
            logger.info(
                "Log file inode changed: %s -> %s", prev_stat.st_ino, new_stat.st_ino
            )
            return True

        # Size decreased by >=99%
        if new_stat.st_size < prev_stat.st_size and prev_stat.st_size > 0:
            decrease_pct = (
                (prev_stat.st_size - new_stat.st_size) / prev_stat.st_size
            ) * 100.0
            if decrease_pct >= 99.0:
                logger.info(
                    "Log file rotated (size: %d -> %d, decrease=%.1f%%)",
                    prev_stat.st_size,
                    new_stat.st_size,
                    decrease_pct,
                )
                return True

        return False

    def get_ip_type(self, ip:str) -> str:
        """Get the IP type of the given IP address.
        
        If the IP address is invalid, return an empty string.
        """
        if not isinstance(ip, str): # pyright: ignore[reportUnnecessaryIsInstance]
            logger.error("IP address must be a string.")
            return ""
        try:
            ip_type = IP(ip).iptype()
            return ip_type
        except ValueError:
            logger.error("Invalid IP address %s.", ip)
            return ""
    
    @lru_cache(maxsize=1024)
    def check_ip_type(self, ip:str) -> bool:
        """Check that the ip type is one of the monitored IP types."""
        ip_type: str = self.get_ip_type(ip)
        if ip_type not in MONITORED_IP_TYPES:
            logger.debug("IP type %s (%s) is not a monitored IP type.", ip_type, ip)
            return False
        return True
    
    def _detect_malformed_request(
        self, matched: re.Match[str]
        ) -> tuple[bool, str | None]:
        """Detect malformed requests such as TLS probes and invalid HTTP.
        
        Returns:
            tuple of (is_malformed, parse_error_message)
        """
        datadict = matched.groupdict()
        method = datadict.get('method')
        request = datadict.get('request', '')
        status_code_str = datadict.get('status_code', '0')
        
        try:
            status_code = int(status_code_str)
        except (ValueError, TypeError):
            status_code = 0
        
        # TLS handshake sent to HTTP port - starts with \x16\x03 (TLS record header)
        # Common patterns: \x16\x03\x01 (TLS 1.0), \x16\x03\x03 (TLS 1.2/1.3)
        # Check both escaped string representation and raw bytes
        if request:
            # Escaped form in log: \x16\x03
            if '\\x16\\x03' in request:
                return True, "TLS handshake sent to HTTP port (escaped)"
            # Raw bytes form (unlikely but possible)
            if '\x16\x03' in request:
                return True, "TLS handshake sent to HTTP port (raw)"
            # SSH probe
            if request.startswith('SSH-') or '\\x53\\x53\\x48' in request:
                return True, "SSH probe sent to HTTP port"
            # SMB probe - \xFFSMB or escaped \x00...\xFFSMB
            if '\\xffSMB' in request.lower() or '\xffSMB' in request or 'SMBr' in request:
                return True, "SMB protocol probe (EternalBlue scanner)"
            if 'NT LM' in request:
                return True, "SMB dialect negotiation probe"
        
        # TLS probe: No HTTP method and 400 status (client sent HTTP to HTTPS port)
        if (method is None or method == '-') and status_code == 400:
            return True, "TLS probe: HTTP request sent to HTTPS port"
        
        # Invalid HTTP method (connection closed before sending valid request)
        if method is None or method == '-':
            return True, "No HTTP method in request"
        
        # Check for non-standard/invalid HTTP methods
        valid_methods = {'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'}
        if method.upper() not in valid_methods:
            return True, f"Invalid HTTP method: {method}"
        
        # nginx-specific status codes that indicate connection issues, not normal HTTP errors
        if status_code == 408:
            return True, "Request timeout (408)"
        
        if status_code == 444:
            return True, "Connection closed without response (nginx 444)"
        
        if status_code == 499:
            return True, "Client closed connection before response (nginx 499)"
        
        return False, None
    
    async def iter_log_events_async(
        self, *, skip_validation: bool = False, start_at_end: bool = True
    ) -> AsyncGenerator[ParsedOrmRecord | None, None]:
        """Async generator that tails the log file and yields ParsedOrmRecord objects.

        This is a native async implementation using aiofiles for non-blocking I/O.
        It integrates cleanly with Litestar's event loop without spawning threads.

        Args:
            skip_validation: Skip initial log format validation.
            start_at_end: If True, seek to end of file (tail -f behavior).
                          If False, read from beginning.

        Yields:
            ParsedOrmRecord for each log line (matched or unmatched).
            None when no new line is available (timeout/idle).
        """
        if not skip_validation:
            logger.debug("Validating log file format.")
            # Run sync validation in thread to avoid blocking
            valid = await asyncio.to_thread(self.validate_log_format)
            if not valid:
                self.send_logs = False
                logger.warning(
                    "Log file format invalid. Streaming without access log objects."
                )

        async with aiofiles.open(self.log_path, "r", encoding="utf-8") as file:
            stat_result = await aiofiles.os.stat(self.log_path)
            self.current_log_inode = stat_result.st_ino

            if start_at_end:
                await file.seek(stat_result.st_size)
            else:
                await file.seek(0) # If the file has been rotated, start at beginning so we don't miss lines

            logger.info("Streaming log file events (async).")

            while not (self._stop_event and self._stop_event.is_set()):
                line = await file.readline()

                if not line:
                    # No new data; yield None to signal idle
                    yield None
                    await asyncio.sleep(self.poll_interval)

                    # Check for rotation
                    if await self._is_rotated_async(stat_result):
                        logger.info("Log rotation detected, restarting from new file.")
                        async for record in self.iter_log_events_async(skip_validation=True, start_at_end=False):
                            yield record
                        return
                    continue

                # Update stat for next rotation check
                stat_result = await aiofiles.os.stat(self.log_path)
                self.current_log_inode = stat_result.st_ino

                matched = self.validate_log_line(line)
                raw_line = line.strip()
                
                if not matched:
                    logger.debug("Skipping unmatched line: '%s'", raw_line)
                    self.skipped_lines += 1
                    yield ParsedOrmRecord(
                        matched=None,
                        ip=None,
                        geo_event=None,
                        access_log=None,
                        raw_line=raw_line,
                        is_malformed=True,
                        parse_error="Line did not match expected log format",
                    )
                    continue

                ip = matched.group(1)
                access_log_obj = (
                    self.create_access_log(matched, ip) if self.send_logs else None
                )
                self.parsed_lines += 1
                
                # Detect malformed requests (TLS probes, invalid HTTP, etc.)
                is_malformed, parse_error = self._detect_malformed_request(matched)

                yield ParsedOrmRecord(
                    matched=matched,
                    ip=ip,
                    geo_event=None,  # Created later after location upsert
                    access_log=access_log_obj,
                    raw_line=raw_line,
                    is_malformed=is_malformed,
                    parse_error=parse_error,
                )

    async def start_async(
        self,
        session_factory: "Callable[[], AsyncSession]",
        *,
        batch_size: int = 100,
        commit_interval: float = 5.0,
        skip_validation: bool = False,
    ) -> None:
        """Start ingestion as an asyncio task within the current event loop.

        Args:
            session_factory: SQLAlchemy async session factory.
            batch_size: Max records before forced commit.
            commit_interval: Max seconds between commits.
            skip_validation: Skip initial log format validation.
        """
        if self._ingestion_task and not self._ingestion_task.done():
            logger.warning("Ingestion task already running.")
            return

        # Validate files exist (sync helpers with retry)
        if not await asyncio.to_thread(self.log_file_exists):
            logger.error(
                "Cannot start ingestion: log file does not exist at %s", self.log_path
            )
            return
        if not await asyncio.to_thread(self.geoip_file_exists):
            logger.error(
                "Cannot start ingestion: GeoIP database does not exist at %s",
                self.geoip_path,
            )
            return

        self._stop_event = asyncio.Event()
        self._ingestion_task = asyncio.create_task(
            self._ingest_async(
                session_factory,
                batch_size=batch_size,
                commit_interval=commit_interval,
                skip_validation=skip_validation,
            ),
            name="logparser-ingest",
        )
        logger.info(
            "Started ingestion task (batch_size=%d, commit_interval=%.1fs)",
            batch_size,
            commit_interval,
        )

    async def stop_async(self, timeout: float = 10.0) -> None:
        """Stop the ingestion task gracefully.

        Args:
            timeout: Seconds to wait before force-cancelling.
        """
        if not self._stop_event or not self._ingestion_task:
            return

        self._stop_event.set()
        try:
            await asyncio.wait_for(self._ingestion_task, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Ingestion task did not exit within timeout, cancelling.")
            self._ingestion_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ingestion_task
        except asyncio.CancelledError:
            pass
        logger.info("Ingestion stopped.")

    async def _ingest_async(
        self,
        session_factory: "Callable[[], AsyncSession]",
        *,
        batch_size: int,
        commit_interval: float,
        skip_validation: bool,
    ) -> None:
        """Core async ingestion loop: reads stream, upserts location, batches commits.
        
        Args:
            session_factory: SQLAlchemy async session factory.
            batch_size: Max records before forced commit.
            commit_interval: Max seconds between commits.
            skip_validation: Skip initial log format validation.
        """
        last_commit = time.monotonic()
        self.pending_lines = 0
        processed = 0

        async with session_factory() as session:
            try:
                async for record in self.iter_log_events_async(
                    skip_validation=skip_validation
                ):
                    if self._stop_event and self._stop_event.is_set():
                        break

                    # Check for interval-based commit even on idle
                    now = time.monotonic()
                    if self.pending_lines > 0 and (now - last_commit) >= commit_interval:
                        await session.commit()
                        logger.debug("Interval commit: %d records, %d total", self.pending_lines, processed)
                        self.pending_lines = 0
                        last_commit = now

                    # None means no new line (idle tick)
                    if record is None:
                        continue

                    # Process record
                    if record.ip:
                        location = await self.upsert_geo_location(session, record.ip)
                        if location:
                            geo_event = self.create_geo_event(record.ip, location)
                            record.geo_event = geo_event
                            session.add(geo_event)

                    if record.access_log:
                        session.add(record.access_log)
                    
                    # Create AccessLogDebug entry if enabled or malformed
                    if self.store_debug_lines or record.is_malformed:
                        await self._create_access_log_debug(
                            session, record
                        )

                    if record.geo_event or record.access_log:
                        self.pending_lines += 1
                    processed += 1

                    # Commit on batch size
                    if self.pending_lines >= batch_size:
                        await session.commit()
                        logger.debug(
                            "Batch commit: %d records, %d total", self.pending_lines, processed
                        )
                        self.pending_lines = 0
                        last_commit = time.monotonic()

            except asyncio.CancelledError:
                logger.info("Ingestion task cancelled.")
                raise
            except Exception as e:
                logger.exception("Ingestion loop error: %s", e)
                raise
            finally:
                # Final commit
                if self.pending_lines > 0:
                    try:
                        await session.commit()
                        logger.debug(
                            "Final commit: %d records, %d total", self.pending_lines, processed
                        )
                    except Exception as e:
                        logger.exception("Final commit failed: %s", e)

        logger.info("Ingestion finished. processed=%d", processed)
    
    async def _create_access_log_debug(
        self,
        session: AsyncSession,
        record: ParsedOrmRecord,
    ) -> None:
        """Create an AccessLogDebug entry for a parsed record.
        
        Links to the AccessLog if available, stores raw_line and malformed info.
        
        Args:
            session: Database session.
            record: ParsedOrmRecord with raw_line and malformed info.
        """
        if not record.raw_line:
            return
        
        # Flush to get the access_log.id if we have one
        if record.access_log:
            await session.flush()
        
        debug_entry = AccessLogDebug(
            access_log_id=record.access_log.id if record.access_log else None,
            raw_line=record.raw_line,
            is_malformed=record.is_malformed,
            parse_error=record.parse_error,
        )
        session.add(debug_entry)
        logger.debug(
            "Created AccessLogDebug: malformed=%s, error=%s",
            record.is_malformed,
            record.parse_error,
        )


    def create_geo_event(self, ip: str, location: GeoLocation):
        """Create an unsaved GeoEvent instance for the given IP with resolved location.

        Args:
            ip: IP address string (validated by caller via upsert_geo_location).
            location: Required GeoLocation instance with an assigned id.

        Returns: GeoEvent instance ready for session.add().
        """
        geo_event = GeoEvent(
            ip_address=ip,
            hostname=self.hostname,
            location_id=location.id
        )
        logger.debug("Constructed GeoEvent for ip=%s location_id=%s", ip, location.id)
        return geo_event
    
    @lru_cache(maxsize=1024)
    def get_ip_data(self, ip: str) -> City|None:
        """Helper to get GeoIP2 data for an IP address."""
        try:
            ip_data = self.geoip_reader.city(ip)
            return ip_data
        except Exception as e:
            logger.debug("GeoIP lookup failed for %s: %s", ip, e)
            return None

    def create_access_log(self, log_data: re.Match[str], ip: str):
        """Create an AccessLog ORM instance (unsaved) from a regex match and IP.

        Parses request/connect timing similar to legacy metrics but returns an ORM object.
        Returns AccessLog instance or None if models/geo lookup unavailable.
        """

        if not log_data or not self.check_ip_type(ip):
            return None
        try:
            ip_data = self.get_ip_data(ip)
        except Exception as e:
            logger.debug("GeoIP lookup failed for %s: %s", ip, e)
            return None
        if not ip_data:
            return None
        datadict: dict[str, str | Any] = log_data.groupdict()
        
        @lru_cache(maxsize=1024)
        def _convert_to_none(value: str | None) -> str | None:
            """Convert '-' or missing values to None for optional fields."""
            if value is None:
                return None
            return value if value != '-' else None
        
        # Safely parse numeric fields
        try:
            request_time = float(datadict.get('request_time', 0))
        except (ValueError, TypeError):
            request_time = 0.0
        try:
            connect_time = float(datadict.get('connect_time', 0)) if datadict.get('connect_time') != '-' else 0.0
        except (ValueError, TypeError):
            connect_time = 0.0
        try:
            bytes_sent = int(datadict.get('bytes_sent', 0))
        except (ValueError, TypeError):
            bytes_sent = 0
        try:
            status_code = int(datadict.get('status_code', 0))
        except (ValueError, TypeError):
            status_code = 0
        try:
            ts = datetime.strptime(datadict['dateandtime'], '%d/%b/%Y:%H:%M:%S %z')
        except Exception:
            ts = datetime.now(timezone.utc)
        access_log = AccessLog(
            timestamp=ts,
            ip_address=ip,
            remote_user=_convert_to_none(datadict.get('remote_user')),
            method=_convert_to_none(datadict.get('method')),
            url=_convert_to_none(datadict.get('url')),
            http_version=_convert_to_none(datadict.get('http_version')),
            status_code=status_code,
            bytes_sent=bytes_sent,
            referrer=_convert_to_none(datadict.get('referrer')),
            user_agent=_convert_to_none(datadict.get('user_agent')),
            request_time=request_time,
            connect_time=connect_time,
            host=_convert_to_none(datadict.get('host')),
            country_code=ip_data.country.iso_code,
            country_name=ip_data.country.name,
            city=ip_data.city.name or datadict.get('city'),
        )
        return access_log

    async def upsert_geo_location(self, session: AsyncSession, ip: str) -> GeoLocation | None:
        """Async helper to fetch/insert a GeoLocation for an IP using provided session.

        Returns the GeoLocation instance or None if lookup fails.
        Safe to call repeatedly; uses geohash uniqueness to prevent duplicates.
        """
        try:
            if not self.check_ip_type(ip):
                return None
            try:
                ip_data = self.geoip_reader.city(ip)
            except Exception as e:
                logger.debug("GeoIP lookup failed for %s: %s", ip, e)
                return None
            if not ip_data:
                logger.debug("No GeoIP data found for IP %s", ip)
                return None
            if not ip_data.location.latitude or not ip_data.location.longitude:
                logger.debug("GeoIP lat/long missing for %s. Database possibly outdated", ip)
                return None
            logger.debug("Encoding geohash for IP %s: lat=%s, long=%s. ipdata=%s", ip, ip_data.location.latitude, ip_data.location.longitude, str(ip_data))
            
            geohash = encode(ip_data.location.latitude, ip_data.location.longitude)

            # Check in-memory cache first
            if cached := self._geolocation_cache.get(geohash):
                return cached
            
            if len(self._geolocation_cache) >= self._cache_maxsize:
                # Evict oldest (first inserted)
                self._geolocation_cache.pop(next(iter(self._geolocation_cache)))
        
            if existing := await GeoLocation.by_geo_hash_async(geohash, session):
                self._geolocation_cache[geohash] = existing
                return existing
            
            location = GeoLocation(
                geohash=geohash,
                latitude=ip_data.location.latitude,
                longitude=ip_data.location.longitude,
                country_code=ip_data.country.iso_code,
                country_name=ip_data.country.name,
                state=ip_data.subdivisions.most_specific.name,
                state_code=ip_data.subdivisions.most_specific.iso_code,
                city=ip_data.city.name,
                postal_code=ip_data.postal.code,
                timezone=ip_data.location.time_zone,
                geographic_point=GeoLocation.make_point(ip_data.location.latitude, ip_data.location.longitude), # type: ignore # lat/long is not nullable
            )
            session.add(location)
            await session.flush()  # assign primary key
            
            self._geolocation_cache[geohash] = location
            return location
        except Exception as e:
            logger.debug("Error upserting GeoLocation for %s: %s", ip, e)
            return None
