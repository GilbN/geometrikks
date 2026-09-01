from collections.abc import AsyncGenerator, Callable
import os
import time
import asyncio
from functools import lru_cache
from ipaddress import ip_address as parse_ip_address, ip_network
from pathlib import Path

import aiofiles.os
import aiofiles
from geoip2.database import Reader
from geoip2.models import ASN, City
from geohash2 import encode
from IPy import IP

from .constants import MONITORED_IP_TYPES
from .formats import FORMATS, sniff_format
from .formats.base import LogLineFormat, NormalizedLine
from .peer_window import PeerSummary, PeerWindow
from .schemas import ParsedLogRecord, ParsedGeoData, ParsedAccessLog
from geometrikks.domain.analytics.cdn_asns import CDN_ASNS
from geometrikks.lib.utils import retries_disabled, sleep_unless_stopped
from geometrikks.server.logging import get_logger


logger = get_logger(__name__)


def get_ip_type(ip: str) -> str:
    """Get the IP type of the given IP address; empty string when invalid."""
    if not isinstance(ip, str):  # pyright: ignore[reportUnnecessaryIsInstance]
        logger.error("IP address must be a string.")
        return ""
    try:
        return IP(ip).iptype()
    except ValueError:
        logger.error("Invalid IP address %s.", ip)
        return ""


@lru_cache(maxsize=1024)
def check_ip_type(ip: str) -> bool:
    """Check that the ip type is one of the monitored IP types."""
    ip_type = get_ip_type(ip)
    if ip_type not in MONITORED_IP_TYPES:
        logger.debug("IP type %s (%s) is not a monitored IP type.", ip_type, ip)
        return False
    return True


PRIVATE_PEER_TYPES = frozenset(
    {"PRIVATE", "CARRIER_GRADE_NAT", "LOOPBACK", "ULA", "LINKLOCAL"}
)


@lru_cache(maxsize=1024)
def is_private_peer(ip: str) -> bool:
    """A peer address that means the proxy logged its upstream, not the client."""
    return get_ip_type(ip) in PRIVATE_PEER_TYPES


def make_cached_city_lookup(reader: Reader, maxsize: int = 1024) -> Callable[[str], City | None]:
    """Build a cached GeoIP city lookup bound to one reader, keyed on IP only.

    The reader is captured in a closure so it stays out of the cache key.
    The returned callable never raises; failed lookups return None.
    """

    @lru_cache(maxsize=maxsize)
    def lookup(ip: str) -> City | None:
        try:
            return reader.city(ip)
        except Exception as e:
            logger.debug("GeoIP lookup failed for %s: %s", ip, e)
            return None

    return lookup


def make_cached_asn_lookup(reader: Reader, maxsize: int = 1024) -> Callable[[str], ASN | None]:
    """Build a cached GeoIP ASN lookup bound to one reader, keyed on IP only.

    Same contract as make_cached_city_lookup: reader captured in a closure,
    never raises, failed lookups return None. Requires a GeoLite2-ASN reader.
    """

    @lru_cache(maxsize=maxsize)
    def lookup(ip: str) -> ASN | None:
        try:
            return reader.asn(ip)
        except Exception as e:
            logger.debug("ASN lookup failed for %s: %s", ip, e)
            return None

    return lookup


def make_cached_ignore_check(ignore_ips: list[str]) -> Callable[[str], bool]:
    """Build a cached membership check for the ignore list, keyed on IP only.

    Networks are parsed once and captured in a closure; invalid client IPs
    return False (they fail later checks anyway).
    """
    networks = [ip_network(entry, strict=False) for entry in ignore_ips]

    @lru_cache(maxsize=1024)
    def is_ignored(ip: str) -> bool:
        if not networks:
            return False
        try:
            addr = parse_ip_address(ip)
        except ValueError:
            return False
        return any(addr in network for network in networks)

    return is_ignored


class LogParser:
    """Tails access logs, parses lines via a pluggable format adapter, and performs GeoIP lookups.

    Log parser module for tailing and parsing access logs.

    This module handles:
    - Tailing access logs asynchronously
    - Parsing log lines through a format adapter (nginx, traefik-json, ...)
    - Performing GeoIP lookups
    - Detecting malformed requests (TLS probes, SSH scans, etc.)
    """

    def __init__(
        self,
        log_path: Path,
        send_logs: bool = False,
        poll_interval: float = 1.0,
        hostname: str = "",
        ignore_ips: list[str] | None = None,
        log_format: str = "auto",
        peer_window: PeerWindow | None = None,
    ) -> None:
        """I'm here to parse ass and kick logs, and I'm all out of logs...

        Args:
            log_path (Path): The path to the log file.
            send_logs (bool, optional): If True, parse full access log data. Defaults to False.
            poll_interval (float, optional): How often to check for new log lines. Defaults to 1.0.
            hostname (str, optional): Source hostname stamped onto parsed
                records. Empty (default): the ingestion service's fallback
                hostname applies.
            ignore_ips (list[str] | None, optional): IPs/CIDRs whose lines are dropped entirely. Defaults to None.
            log_format (str, optional): A registry name from ``formats.FORMATS`` (e.g. "nginx"),
                or "auto" to sniff the format from the first parseable line. Defaults to "auto".
            peer_window (PeerWindow | None, optional): Rolling classifier for
                the logged peer address (client vs. proxy upstream vs. CDN
                edge). None: peer classification off (APP_PROXY_ADVISORY=false).
        """
        self.log_path: Path = log_path
        self.send_logs: bool = send_logs
        self.poll_interval: int | float = poll_interval
        self.hostname: str = hostname
        self.ignore_ips: list[str] = ignore_ips or []
        self._is_ignored: Callable[[str], bool] = make_cached_ignore_check(self.ignore_ips)
        self.peer_window: PeerWindow | None = peer_window

        if log_format != "auto" and log_format not in FORMATS:
            raise ValueError(f"Unknown log format: {log_format!r}")
        self.log_format_setting: str = log_format
        self.format: LogLineFormat | None = (
            FORMATS[log_format] if log_format != "auto" else None
        )

        # Statistics
        self.parsed_lines: int = 0
        self.skipped_lines: int = 0
        self.ignored_lines: int = 0

        # True while the tailed file is missing mid-flight (deleted/moved);
        # surfaced through LogIngestionService.missing_files into /health.
        self.file_missing: bool = False

        # Stop event for graceful shutdown (set by ingestion service)
        self._stop_event: asyncio.Event | None = None

        logger.debug("Log file path: %s", self.log_path)
        logger.debug("Send access logs: %s", self.send_logs)
        logger.debug("Hostname: %s", self.hostname)
        if self.ignore_ips:
            logger.info("Ignoring traffic from: %s", ", ".join(self.ignore_ips))

    def set_stop_event(self, event: asyncio.Event) -> None:
        """Set the stop event for graceful shutdown."""
        self._stop_event = event

    def _mark_file_missing(self, err: OSError) -> None:
        """Record (and log exactly once) that the tailed file disappeared."""
        if not self.file_missing:
            logger.error(
                "Log file no longer exists or cannot be read: %s - "
                "waiting for it to reappear (%s)",
                self.log_path,
                err,
            )
            self.file_missing = True

    def _mark_file_present(self) -> None:
        """Clear the missing flag, logging the recovery once."""
        if self.file_missing:
            logger.info("Log file reappeared, resuming tail: %s", self.log_path)
            self.file_missing = False

    def parsed_lines_count(self) -> int:
        """Return the number of parsed lines."""
        return self.parsed_lines

    def skipped_lines_count(self) -> int:
        """Return the number of skipped lines."""
        return self.skipped_lines

    def ignored_lines_count(self) -> int:
        """Return the number of ignored (ignore-list) lines."""
        return self.ignored_lines

    def peer_summary(self) -> "PeerSummary | None":
        """Peer-kind window state for /health; None when classification is off."""
        return self.peer_window.summary() if self.peer_window else None

    def _lock_format(self, lines: list[str]) -> None:
        """Sniff the format from candidate lines and lock it in (auto mode).

        Feed as many lines as are available: a single near-miss line would
        otherwise decide the mode for the whole file.

        Args:
            lines: Candidate raw log lines.
        """
        if self.format is not None:
            return
        sniffed = sniff_format(lines)
        if sniffed is None:
            return
        self.format = sniffed.format
        logger.info(
            "log_format_detected", path=str(self.log_path), format=sniffed.format.name
        )
        if sniffed.geo_only and self.send_logs:
            # Only the relaxed ip+timestamp pattern matched, so a full parse
            # would fail for every line: the file would produce no geo events,
            # no access logs and one malformed debug row per line. Degrade
            # exactly like a pinned format that fails validation does.
            self.send_logs = False
            logger.warning(
                "Log file %s matched %s only on its geo-only pattern. "
                "Streaming without access log objects.",
                self.log_path,
                sniffed.format.name,
            )

    def validate_log_line(self, log_line: str) -> NormalizedLine | None:
        """Parse the line with the locked format; sniff-and-lock when auto."""
        self._lock_format([log_line])
        if self.format is None:
            return None
        return self.format.parse(log_line, geo_only=not self.send_logs)

    def validate_log_format(self, log_path: Path) -> bool:  # regex tester
        """Validate the log format once by checking the last 3 lines.

        Blocking (opens and reads the file); callers on the event loop go
        through ``await_valid_log_format`` instead of calling this directly.
        """
        LAST_LINE_COUNT = 3
        position = LAST_LINE_COUNT + 1
        log_lines_capture: list[str] = []
        lines = []
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
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
        self._lock_format(lines)
        for line in lines:
            if self.validate_log_line(line):
                logger.info("Log file format is valid!")
                return True
        logger.debug("Testing log format")
        return False

    async def await_valid_log_format(
        self,
        timeout_seconds: float = 60.0,
        check_interval: float = 1.0,
    ) -> bool:
        """Retry the format check until it passes, times out, or a stop is requested.

        Each attempt offloads the blocking file read to a worker thread, but
        the waiting between attempts happens here on the event loop. A thread
        handed to ``asyncio.to_thread`` cannot be cancelled, so retrying
        inside the thread (the previous behaviour) kept the process busy for
        the full timeout after shutdown had been requested: the awaiting task
        raised ``CancelledError`` immediately while the thread kept sleeping,
        and the interpreter could not finish exiting until it returned. This
        is reachable whenever the configured log file exists but is empty or
        in an unrecognised format, which is the normal state of a fresh
        install before the web server writes its first line.

        Args:
            timeout_seconds: Maximum seconds to keep retrying.
            check_interval: Seconds between attempts.

        Returns:
            True if the format validated, False on timeout or stop request.
        """
        if retries_disabled():
            return await asyncio.to_thread(self.validate_log_format, self.log_path)

        deadline = time.monotonic() + timeout_seconds
        while True:
            if self._stop_event and self._stop_event.is_set():
                return False
            if await asyncio.to_thread(self.validate_log_format, self.log_path):
                return True
            if time.monotonic() >= deadline:
                logger.error(
                    "Timeout of %.0f seconds reached validating the log format of %s",
                    timeout_seconds,
                    self.log_path,
                )
                return False
            if await sleep_unless_stopped(check_interval, self._stop_event):
                return False

    def parse_line(
        self,
        line: str,
        lookup: Callable[[str], City | None],
        asn_lookup: Callable[[str], ASN | None] | None = None,
    ) -> ParsedLogRecord | None:
        """Parse one raw log line into a ParsedLogRecord (shared by tail + import).

        Pure, synchronous method that parses the line via the format adapter,
        performs GeoIP lookup, and detects malformed requests. Updates
        self.parsed_lines/self.skipped_lines.

        Args:
            line: Raw log line to parse.
            lookup: Callable to look up City data for an IP address.

        Returns:
            ParsedLogRecord with parsed data. A record with ip_address=None
            indicates the line didn't match the format (counted in
            skipped_lines). None when the client IP is on the ignore list;
            the line is dropped and counted in ignored_lines.
        """
        norm = self.validate_log_line(line)
        raw_line = line.strip()

        if norm is None:
            logger.debug("Skipping unmatched line: '%s'", raw_line)
            self.skipped_lines += 1
            return ParsedLogRecord(
                ip_address=None,
                geo_data=None,
                access_log=None,
                raw_line=raw_line,
                is_malformed=True,
                parse_error="Line did not match expected log format",
                source=str(self.log_path),
                log_format=self.format.name if self.format else None,
                hostname=self.hostname,
            )

        ip = norm.ip_address

        if self._is_ignored(ip):
            logger.debug("Ignoring line from ignored IP %s", ip)
            self.ignored_lines += 1
            return None

        self.parsed_lines += 1

        # validate_log_line only returns a NormalizedLine once self.format is
        # locked (explicit, or sniffed-and-locked on the first matching line).
        # Not an assert: asserts are stripped under python -O and this is a
        # data-path invariant.
        if self.format is None:
            raise RuntimeError("Parsed a line without a locked log format")

        geo_data: ParsedGeoData | None = self._parse_geo_data(ip, norm, lookup)
        access_log: ParsedAccessLog | None = (
            self._parse_access_log(norm, ip, lookup, asn_lookup) if self.send_logs else None
        )
        is_malformed, parse_error = (
            self.format.detect_malformed(norm) if self.send_logs else (False, None)
        )

        if self.peer_window is not None:
            self._record_peer(ip, access_log)

        return ParsedLogRecord(
            ip_address=ip,
            geo_data=geo_data,
            access_log=access_log,
            raw_line=raw_line,
            is_malformed=is_malformed,
            parse_error=parse_error,
            source=str(self.log_path),
            log_format=self.format.name if self.format else None,
            hostname=self.hostname,
        )

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
            # Deleted/moved mid-tail: log once, keep polling. When the file
            # reappears the inode-change branch below reopens it.
            self._mark_file_missing(e)
            return False
        self._mark_file_present()

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

    def _parse_geo_data(
        self, ip: str, norm: NormalizedLine, lookup: Callable[[str], City | None]
    ) -> ParsedGeoData | None:
        """Extract geographic data from IP address.

        Args:
            ip: IP address string.

        Returns:
            ParsedGeoData if successful, None otherwise.
        """
        if not check_ip_type(ip):
            return None

        ip_data: City | None = lookup(ip)

        if not ip_data:
            logger.debug("No GeoIP data found for IP %s", ip)
            return None

        if not ip_data.location.latitude or not ip_data.location.longitude:
            logger.debug("GeoIP lat/long missing for %s. Database possibly outdated", ip)
            return None

        # GeoLocation.country_code/country_name are NOT NULL; skip records the
        # database cannot store (e.g. anonymous/satellite ranges without country).
        country_code = ip_data.country.iso_code
        country_name = ip_data.country.name
        if not country_code or not country_name:
            logger.debug("GeoIP country missing for %s. Skipping geo record", ip)
            return None

        ts = norm.timestamp
        logger.debug(
            "Parsing geo data for IP %s: lat=%s, long=%s. Country=%s, City=%s",
            ip,
            ip_data.location.latitude,
            ip_data.location.longitude,
            ip_data.country.iso_code,
            ip_data.city.name,
        )

        return ParsedGeoData(
            latitude=ip_data.location.latitude,
            longitude=ip_data.location.longitude,
            geohash=encode(ip_data.location.latitude, ip_data.location.longitude),
            country_code=country_code,
            country_name=country_name,
            state=ip_data.subdivisions.most_specific.name,
            state_code=ip_data.subdivisions.most_specific.iso_code,
            city=ip_data.city.name,
            postal_code=ip_data.postal.code,
            timezone=ip_data.location.time_zone,
            timestamp=ts
        )

    def _parse_access_log(
        self,
        norm: NormalizedLine,
        ip: str,
        lookup: Callable[[str], City | None],
        asn_lookup: Callable[[str], ASN | None] | None = None,
    ) -> ParsedAccessLog | None:
        """Build the ParsedAccessLog for a normalized line, enriched with GeoIP.

        Args:
            norm: Normalized line from the format adapter.
            ip: IP address string.
            lookup: Callable to look up City data for an IP address.

        Returns:
            ParsedAccessLog if the IP is monitored and has GeoIP data, None otherwise.
        """
        if not check_ip_type(ip):
            return None
        ip_data: City | None = lookup(ip)
        if not ip_data:
            return None
        asn_data: ASN | None = asn_lookup(ip) if asn_lookup is not None else None
        return ParsedAccessLog(
            timestamp=norm.timestamp,
            ip_address=ip,
            remote_user=norm.remote_user,
            method=norm.method,
            url=norm.path,
            http_version=norm.http_version,
            status_code=norm.status_code,
            bytes_sent=norm.bytes_sent,
            referrer=norm.referrer,
            user_agent=norm.user_agent,
            request_time=norm.request_time,
            upstream_response_time=norm.upstream_response_time,
            host=norm.host,
            country_code=ip_data.country.iso_code,
            country_name=ip_data.country.name,
            city=ip_data.city.name,
            autonomous_system_number=(
                asn_data.autonomous_system_number if asn_data else None
            ),
            autonomous_system_organization=(
                asn_data.autonomous_system_organization if asn_data else None
            ),
        )

    def _record_peer(self, ip: str, access_log: ParsedAccessLog | None) -> None:
        """Classify one peer address and log it into the rolling window.

        CDN classification reads the ASN already carried by access_log, not a
        fresh asn_lookup(ip) call: that keeps this on a zero-mmdb-read budget.
        The trade-off is by design, not a gap to close: lines with no
        access-log row - geo-only mode (send_logs=False), or a City-lookup
        miss even in full mode - classify as "other" here even when the peer
        is a CDN edge. Private-peer detection is unaffected since it never
        needs the ASN.
        """
        window = self.peer_window
        if window is None:
            return
        if not check_ip_type(ip):
            if not is_private_peer(ip):
                return  # reserved/multicast: noise, not a proxy symptom
            window.record("private")
        else:
            asn = access_log.autonomous_system_number if access_log else None
            provider = CDN_ASNS.get(asn) if asn is not None else None
            if provider:
                window.record("cdn", provider)
            else:
                window.record("other")
        for t in window.check():
            summary = window.summary()
            logger.warning(
                "proxy_peer_detected" if t.active else "proxy_peer_cleared",
                hostname=self.hostname,
                path=str(self.log_path),
                kind=t.kind,
                share=round(t.share, 3),
                lines=t.lines,
                provider=summary.top_provider if t.kind == "cdn" else None,
                log_format=self.format.name if self.format else None,
            )

    async def iter_parsed_records(
        self,
        reader: Reader,
        asn_reader: Reader | None = None,
        *,
        skip_validation: bool = False,
        start_at_end: bool = True,
    ) -> AsyncGenerator[ParsedLogRecord | None, None]:
        """Async generator that tails the log file and yields ParsedLogRecord objects.

        This is a native async implementation using aiofiles for non-blocking I/O.
        On log rotation, reopens the file in a loop instead of recursing.

        Args:
            skip_validation: Skip initial log format validation.
            start_at_end: If True, seek to end of file (tail -f behavior).
                          If False, read from beginning.

        Yields:
            ParsedLogRecord for each log line (matched or unmatched).
            None when no new line is available (timeout/idle) or the line's
            IP is on the ignore list.
        """
        if not skip_validation:
            logger.debug("Validating log file format.")
            valid = await self.await_valid_log_format()
            if self._stop_event and self._stop_event.is_set():
                # Stopped while waiting for a parseable line; say nothing about
                # the format, the tail loop below would exit immediately anyway.
                return
            if not valid:
                if self.log_format_setting == "auto" and self.format is None:
                    logger.warning(
                        "Log format not detected yet for %s; will sniff incoming lines",
                        self.log_path,
                    )
                else:
                    self.send_logs = False
                    logger.warning(
                        "Log file format invalid. Streaming without access log objects."
                    )

        lookup = make_cached_city_lookup(reader)
        asn_lookup = (
            make_cached_asn_lookup(asn_reader) if asn_reader is not None else None
        )

        seek_to_end = start_at_end
        while not (self._stop_event and self._stop_event.is_set()):
            # Stat before (re)opening: after a rotation break the new file may
            # not exist yet, and crashing here would kill the tail task.
            try:
                stat_result = await aiofiles.os.stat(self.log_path)
            except OSError as e:
                self._mark_file_missing(e)
                yield None
                await asyncio.sleep(self.poll_interval)
                continue
            self._mark_file_present()

            async with aiofiles.open(
                self.log_path, "r", encoding="utf-8", errors="replace"
            ) as file:
                if seek_to_end:
                    await file.seek(stat_result.st_size)
                # After a rotation we always read the new file from the start
                seek_to_end = False

                logger.info("Streaming log file events (async): %s", self.log_path)

                while not (self._stop_event and self._stop_event.is_set()):
                    line = await file.readline()

                    if not line:
                        # No new data; yield None to signal idle
                        yield None
                        await asyncio.sleep(self.poll_interval)

                        if await self._is_rotated_async(stat_result):
                            logger.info(
                                "Log rotation detected, reopening from start: %s",
                                self.log_path,
                            )
                            break  # close this file; outer loop reopens
                        continue

                    # Update stat for next rotation check. The file can vanish
                    # between the read and this stat; keep the previous stat
                    # and let the idle-path rotation check flag the miss.
                    try:
                        stat_result = await aiofiles.os.stat(self.log_path)
                    except OSError:
                        pass

                    yield self.parse_line(line, lookup, asn_lookup)
