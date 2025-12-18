from collections.abc import AsyncGenerator
import re
import os
import time
import logging
import asyncio
from functools import wraps, lru_cache
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ParamSpec, Callable

import aiofiles.os
import aiofiles
from geoip2.database import Reader
from geoip2.models import City
from geohash2 import encode
from IPy import IP

from .constants import (
    ipv4_pattern,
    ipv6_pattern,
    MONITORED_IP_TYPES,
    ipv4,
    ipv6,
    ALLOWED_GEOIP_LOCALES,
    GEOIP_LOCALES_DEFAULT,
)
from .schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog


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
    """Parses nginx access logs and performs GeoIP lookups.

    Log parser module for tailing and parsing nginx access logs.

    This module handles:
    - Tailing nginx access logs asynchronously
    - Validating log lines against regex patterns
    - Performing GeoIP lookups
    - Detecting malformed requests (TLS probes, SSH scans, etc.)
    """

    def __init__(
        self,
        log_path: Path,
        geoip_path: Path,
        geoip_locales: list[str],
        send_logs: bool = False,
        poll_interval: float = 1.0,
        hostname: str = "localhost",
    ) -> None:
        """I'm here to parse ass and kick logs, and I'm all out of logs...

        Args:
            log_path (Path): The path to the log file.
            geoip_path (Path): The path the the GeoLite mmdb file.
            geoip_locales (list[str]): List of locales (en,de,it etc)
            send_logs (bool, optional): If True, parse full access log data. Defaults to False.
            poll_interval (float, optional): How often to check for new log lines. Defaults to 1.0.
            hostname (str, optional): Hostname to tag geo events with. Defaults to "localhost".
        """
        self.log_path = log_path
        self.geoip_path = geoip_path
        self.geoip_locales = geoip_locales
        self.send_logs = send_logs
        self.poll_interval = poll_interval
        self.hostname = hostname

        if any(loc not in ALLOWED_GEOIP_LOCALES for loc in geoip_locales):
            logger.warning(
                "Unmatched GeoIp2 locale found. Allowed are '%s', defaulting to 'en'",
                ALLOWED_GEOIP_LOCALES,
            )
            self.geoip_locales = GEOIP_LOCALES_DEFAULT

        self.geoip_reader = Reader(self.geoip_path)
        self.current_log_inode: int | None = None

        # Statistics
        self.parsed_lines: int = 0
        self.skipped_lines: int = 0

        # Stop event for graceful shutdown (set by ingestion service)
        self._stop_event: asyncio.Event | None = None

        logger.debug("Log file path: %s", self.log_path)
        logger.debug("GeoIP database path: %s", self.geoip_path)
        logger.debug("Send NGINX logs: %s", self.send_logs)
        logger.debug("Hostname: %s", self.hostname)

    def set_stop_event(self, event: asyncio.Event) -> None:
        """Set the stop event for graceful shutdown."""
        self._stop_event = event

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
        return ipv4().match(log_line) or ipv6().match(log_line)

    @wait(timeout_seconds=60)
    def validate_log_format(self) -> bool:  # regex tester
        """Try for 60 seconds and validate that the log format is correct by checking the last 3 lines."""
        LAST_LINE_COUNT = 3
        position = LAST_LINE_COUNT + 1
        log_lines_capture: list[str] = []
        lines = []
        with open(self.log_path, "r", encoding="utf-8") as f:
            while len(log_lines_capture) <= LAST_LINE_COUNT:
                try:
                    f.seek(-position, os.SEEK_END)  # Move to the last line
                except (IOError, OSError):
                    f.seek(os.SEEK_SET)  # Start of file
                    break
                finally:
                    log_lines_capture = list(f)  # Read all lines from the current position
                position *= 2  # Double the position to read more lines
        lines = log_lines_capture[-LAST_LINE_COUNT:]  # Get the last 3 lines
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

    def get_ip_type(self, ip: str) -> str:
        """Get the IP type of the given IP address.
        
        If the IP address is invalid, return an empty string.
        """
        if not isinstance(ip, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            logger.error("IP address must be a string.")
            return ""
        try:
            ip_type = IP(ip).iptype()
            return ip_type
        except ValueError:
            logger.error("Invalid IP address %s.", ip)
            return ""

    @lru_cache(maxsize=1024)
    def check_ip_type(self, ip: str) -> bool:
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
        method = datadict.get("method")
        request = datadict.get("request", "")
        status_code_str = datadict.get("status_code", "0")

        try:
            status_code = int(status_code_str)
        except (ValueError, TypeError):
            status_code = 0

        # TLS handshake sent to HTTP port - starts with \x16\x03 (TLS record header)
        # Common patterns: \x16\x03\x01 (TLS 1.0), \x16\x03\x03 (TLS 1.2/1.3)
        # Check both escaped string representation and raw bytes
        if request:
            # Escaped form in log: \x16\x03
            if "\\x16\\x03" in request:
                return True, "TLS handshake sent to HTTP port (escaped)"
            # Raw bytes form (unlikely but possible)
            if "\x16\x03" in request:
                return True, "TLS handshake sent to HTTP port (raw)"
            # SSH probe
            if request.startswith("SSH-") or "\\x53\\x53\\x48" in request:
                return True, "SSH probe sent to HTTP port"
            # SMB probe - \xFFSMB or escaped \x00...\xFFSMB
            if (
                "\\xffSMB" in request.lower()
                or "\xffSMB" in request
                or "SMBr" in request
            ):
                return True, "SMB protocol probe (EternalBlue scanner)"
            if "NT LM" in request:
                return True, "SMB dialect negotiation probe"

        # TLS probe: No HTTP method and 400 status (client sent HTTP to HTTPS port)
        if (method is None or method == "-") and status_code == 400:
            return True, "TLS probe: HTTP request sent to HTTPS port"

        # Invalid HTTP method (connection closed before sending valid request)
        if method is None or method == "-":
            return True, "No HTTP method in request"

        # Check for non-standard/invalid HTTP methods
        valid_methods = {
            "GET",
            "POST",
            "PUT",
            "DELETE",
            "PATCH",
            "HEAD",
            "OPTIONS",
            "CONNECT",
            "TRACE",
        }
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

    @lru_cache(maxsize=1024)
    def get_ip_data(self, ip: str) -> City | None:
        """Helper to get GeoIP2 data for an IP address."""
        try:
            ip_data = self.geoip_reader.city(ip)
            return ip_data
        except Exception as e:
            logger.debug("GeoIP lookup failed for %s: %s", ip, e)
            return None

    def _parse_geo_data(self, ip: str, log_data: re.Match[str]) -> ParsedGeoData | None:
        """Extract geographic data from IP address.

        Args:
            ip: IP address string.

        Returns:
            ParsedGeoData if successful, None otherwise.
        """
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
        
        datadict: dict[str, str | Any] = log_data.groupdict()
        
        try:
            ts = datetime.strptime(datadict["dateandtime"], "%d/%b/%Y:%H:%M:%S %z")
        except Exception:
            ts = datetime.now(timezone.utc)
            
        logger.debug(
            "Encoding geohash for IP %s: lat=%s, long=%s. ipdata=%s",
            ip,
            ip_data.location.latitude,
            ip_data.location.longitude,
            str(ip_data),
        )

        return ParsedGeoData(
            latitude=ip_data.location.latitude,
            longitude=ip_data.location.longitude,
            geohash=encode(ip_data.location.latitude, ip_data.location.longitude),
            country_code=ip_data.country.iso_code,
            country_name=ip_data.country.name,
            state=ip_data.subdivisions.most_specific.name,
            state_code=ip_data.subdivisions.most_specific.iso_code,
            city=ip_data.city.name,
            postal_code=ip_data.postal.code,
            timezone=ip_data.location.time_zone,
            timestamp=ts
        )

    def _parse_access_log(
        self, log_data: re.Match[str], ip: str
    ) -> ParsedAccessLog | None:
        """Parse access log fields from regex match.

        Parses request/connect timing similar to legacy metrics but returns a dataclass.

        Args:
            log_data: Regex match object from log line.
            ip: IP address string.

        Returns:
            ParsedAccessLog if successful, None otherwise.
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
            return value if value != "-" else None

        # Safely parse numeric fields
        try:
            request_time = float(datadict.get("request_time", 0))
        except (ValueError, TypeError):
            request_time = 0.0

        try:
            connect_time_str = datadict.get("connect_time")
            connect_time = (
                float(connect_time_str)
                if connect_time_str and connect_time_str != "-"
                else None
            )
        except (ValueError, TypeError):
            connect_time = None

        try:
            bytes_sent = int(datadict.get("bytes_sent", 0))
        except (ValueError, TypeError):
            bytes_sent = 0

        try:
            status_code = int(datadict.get("status_code", 0))
        except (ValueError, TypeError):
            status_code = 0

        try:
            ts = datetime.strptime(datadict["dateandtime"], "%d/%b/%Y:%H:%M:%S %z")
        except Exception:
            ts = datetime.now(timezone.utc)

        return ParsedAccessLog(
            timestamp=ts,
            ip_address=ip,
            remote_user=_convert_to_none(datadict.get("remote_user")),
            method=_convert_to_none(datadict.get("method")),
            url=_convert_to_none(datadict.get("url")),
            http_version=_convert_to_none(datadict.get("http_version")),
            status_code=status_code,
            bytes_sent=bytes_sent,
            referrer=_convert_to_none(datadict.get("referrer")),
            user_agent=_convert_to_none(datadict.get("user_agent")),
            request_time=request_time,
            connect_time=connect_time,
            host=_convert_to_none(datadict.get("host")),
            country_code=ip_data.country.iso_code,
            country_name=ip_data.country.name,
            city=ip_data.city.name or datadict.get("city"),
        )

    async def iter_parsed_records(
        self, *, skip_validation: bool = False, start_at_end: bool = True
    ) -> AsyncGenerator[ParsedLogRecord | None, None]:
        """Async generator that tails the log file and yields ParsedLogRecord objects.

        This is a native async implementation using aiofiles for non-blocking I/O.

        Args:
            skip_validation: Skip initial log format validation.
            start_at_end: If True, seek to end of file (tail -f behavior).
                          If False, read from beginning.

        Yields:
            ParsedLogRecord for each log line (matched or unmatched).
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
                await file.seek(0)  # If the file has been rotated, start at beginning so we don't miss lines

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
                        async for record in self.iter_parsed_records(skip_validation=True, start_at_end=False):
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
                    yield ParsedLogRecord(
                        ip_address=None,
                        geo_data=None,
                        access_log=None,
                        raw_line=raw_line,
                        is_malformed=True,
                        parse_error="Line did not match expected log format",
                    )
                    continue

                ip = matched.group(1)
                self.parsed_lines += 1

                # Parse geo data
                geo_data = self._parse_geo_data(ip, matched)

                # Parse access log if enabled
                access_log = (
                    self._parse_access_log(matched, ip) if self.send_logs else None
                )

                # Detect malformed requests (TLS probes, invalid HTTP, etc.)
                is_malformed, parse_error = self._detect_malformed_request(matched)

                yield ParsedLogRecord(
                    ip_address=ip,
                    geo_data=geo_data,
                    access_log=access_log,
                    raw_line=raw_line,
                    is_malformed=is_malformed,
                    parse_error=parse_error,
                )
