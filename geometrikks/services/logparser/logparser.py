from collections.abc import Callable
from functools import lru_cache
from ipaddress import ip_address as parse_ip_address, ip_network

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
    """Parses access-log lines via a pluggable format adapter and performs GeoIP lookups.

    This class handles:
    - Parsing log lines through a format adapter (nginx, traefik-json, ...)
    - Performing GeoIP lookups
    - Detecting malformed requests (TLS probes, SSH scans, etc.)

    Where the lines come from is a LogSource's job (services/logsources).
    """

    def __init__(
        self,
        source_label: str,
        send_logs: bool = False,
        hostname: str = "",
        ignore_ips: list[str] | None = None,
        log_format: str = "auto",
        peer_window: PeerWindow | None = None,
    ) -> None:
        """I'm here to parse ass and kick logs, and I'm all out of logs...

        Args:
            source_label (str): Label of the source the lines come from (a file
                path for a tailed file). Stamped onto records and log events.
            send_logs (bool, optional): If True, parse full access log data. Defaults to False.
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
        self.source_label: str = source_label
        self.send_logs: bool = send_logs
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

        logger.debug("Log source: %s", self.source_label)
        logger.debug("Send access logs: %s", self.send_logs)
        logger.debug("Hostname: %s", self.hostname)
        if self.ignore_ips:
            logger.info("Ignoring traffic from: %s", ", ".join(self.ignore_ips))

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
            "log_format_detected", path=self.source_label, format=sniffed.format.name
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
                self.source_label,
                sniffed.format.name,
            )

    def validate_log_line(self, log_line: str) -> NormalizedLine | None:
        """Parse the line with the locked format; sniff-and-lock when auto."""
        self._lock_format([log_line])
        if self.format is None:
            return None
        return self.format.parse(log_line, geo_only=not self.send_logs)

    def lock_format_from(self, lines: list[str]) -> bool:
        """Lock the format from sample lines; True when one of them parses."""
        self._lock_format(lines)
        for line in lines:
            if self.validate_log_line(line):
                logger.info("Log file format is valid!")
                return True
        logger.debug("Testing log format")
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
                source=self.source_label,
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

        # One ASN read per line, shared by both records: geo-only installs
        # (send_logs=False) never build an access log, so the lookup cannot
        # live inside _parse_access_log.
        asn_data: ASN | None = (
            asn_lookup(ip) if asn_lookup is not None and check_ip_type(ip) else None
        )
        geo_data: ParsedGeoData | None = self._parse_geo_data(ip, norm, lookup, asn_data)
        access_log: ParsedAccessLog | None = (
            self._parse_access_log(norm, ip, lookup, asn_data) if self.send_logs else None
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
            source=self.source_label,
            log_format=self.format.name if self.format else None,
            hostname=self.hostname,
        )

    def _parse_geo_data(
        self,
        ip: str,
        norm: NormalizedLine,
        lookup: Callable[[str], City | None],
        asn_data: ASN | None = None,
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
            timestamp=ts,
            autonomous_system_number=(
                asn_data.autonomous_system_number if asn_data else None
            ),
            autonomous_system_organization=(
                asn_data.autonomous_system_organization if asn_data else None
            ),
        )

    def _parse_access_log(
        self,
        norm: NormalizedLine,
        ip: str,
        lookup: Callable[[str], City | None],
        asn_data: ASN | None = None,
    ) -> ParsedAccessLog | None:
        """Build the ParsedAccessLog for a normalized line, enriched with GeoIP.

        Args:
            norm: Normalized line from the format adapter.
            ip: IP address string.
            lookup: Callable to look up City data for an IP address.
            asn_data: Resolved ASN record for the IP, or None.

        Returns:
            ParsedAccessLog if the IP is monitored and has GeoIP data, None otherwise.
        """
        if not check_ip_type(ip):
            return None
        ip_data: City | None = lookup(ip)
        if not ip_data:
            return None
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
                path=self.source_label,
                kind=t.kind,
                share=round(t.share, 3),
                lines=t.lines,
                provider=summary.top_provider if t.kind == "cdn" else None,
                log_format=self.format.name if self.format else None,
            )
