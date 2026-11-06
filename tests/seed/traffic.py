"""Turns the visitor population into rows shaped the way live ingestion writes them."""

from __future__ import annotations

import json
import math
import random
from collections.abc import Iterator
from itertools import accumulate
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import NamedTuple

from tests.seed.catalog import (
    BROWSER_METHODS,
    CRAWLER_PATHS,
    HTTP_VERSIONS,
    LOG_FORMATS,
    PROBES,
    SCANNER_REQUESTS,
    SEARCH_REFERRERS,
    SITES,
    STATUSES,
    UNPARSEABLE_LINES,
    pick_weighted,
)
from tests.seed.config import SeedConfig
from tests.seed.visitors import Visitor

VISITOR_ZIPF_EXPONENT = 0.9
# Crawlers visit steadily but rarely; a crawler topping the IP list looks wrong.
KIND_WEIGHTS = {"browser": 1.0, "scanner": 1.0, "crawler": 0.15, "lan": 1.0}
PROBE_SHARE = 0.06
UNPARSEABLE_SHARE = 0.002
UNPARSEABLE_ERROR = "Line did not match expected log format"
# Relative chance a person is online at each local hour: lowest at 04:00, highest at 16:00.
DIURNAL = tuple(0.2 + 0.4 * (1 - math.cos(2 * math.pi * (hour - 4) / 24)) for hour in range(24))
SCANNER_REQUEST_OPTIONS = tuple(((method, path), weight) for method, path, weight in SCANNER_REQUESTS)


class AccessLogRow(NamedTuple):
    timestamp: datetime
    ip_address: str
    remote_user: str | None
    method: str | None
    url: str | None
    http_version: str | None
    status_code: int
    bytes_sent: int
    referrer: str | None
    user_agent: str | None
    request_time: float | None
    upstream_response_time: float | None
    host: str | None
    country_code: str | None
    country_name: str | None
    city: str | None
    autonomous_system_number: int | None
    autonomous_system_organization: str | None
    server: str
    log_format: str


class GeoEventRow(NamedTuple):
    timestamp: datetime
    ip_address: str
    server: str
    location_id: int
    autonomous_system_number: int | None
    autonomous_system_organization: str | None


class DebugRow(NamedTuple):
    access_log_id: int | None
    created_at: datetime
    raw_line: str
    is_malformed: bool
    parse_error: str | None
    log_format: str | None
    log_timestamp: datetime | None
    ip_address: str | None
    method: str | None
    url: str | None
    host: str | None
    status_code: int | None
    country_code: str | None
    country_name: str | None
    city: str | None
    user_agent: str | None


@dataclass(slots=True)
class Batch:
    """One write unit. ``linked`` access logs need ids before their debug rows can point at them."""

    access_logs: list[AccessLogRow] = field(default_factory=list)
    linked: list[tuple[AccessLogRow, DebugRow]] = field(default_factory=list)
    geo_events: list[GeoEventRow] = field(default_factory=list)
    orphan_debug: list[DebugRow] = field(default_factory=list)


def debug_row_for(log: AccessLogRow, raw_line: str, parse_error: str | None) -> DebugRow:
    """The debug row ingestion writes for ``log``, with its context copied over."""
    return DebugRow(
        access_log_id=None,
        created_at=log.timestamp,
        raw_line=raw_line,
        is_malformed=parse_error is not None,
        parse_error=parse_error,
        log_format=log.log_format,
        log_timestamp=log.timestamp,
        ip_address=log.ip_address,
        method=log.method,
        url=log.url,
        host=log.host,
        status_code=log.status_code,
        country_code=log.country_code,
        country_name=log.country_name,
        city=log.city,
        user_agent=log.user_agent,
    )


def raw_line(log: AccessLogRow, request: str) -> str:
    """The line as the server's log format would have written it."""
    if log.log_format == "nginx":
        upstream = f"{log.upstream_response_time:.3f}" if log.upstream_response_time is not None else "-"
        return (
            f"{log.ip_address} - {log.remote_user or '-'} [{log.timestamp:%d/%b/%Y:%H:%M:%S %z}] "
            f'"{request}" {log.status_code} {log.bytes_sent} "{log.referrer or "-"}" {log.host or "-"} '
            f'"{log.user_agent or "-"}" "{log.request_time or 0:.3f}" "{upstream}"'
        )
    return json.dumps(
        {
            "client_ip": log.ip_address,
            "timestamp": log.timestamp.isoformat(timespec="seconds"),
            "method": log.method or "",
            "path": log.url or "",
            "protocol": log.http_version or "",
            "status": str(log.status_code),
            "bytes": str(log.bytes_sent),
            "host": log.host or "",
            "referrer": log.referrer or "",
            "user_agent": log.user_agent or "",
            "remote_user": log.remote_user or "",
            "request_time": f"{log.request_time or 0:.3f}",
            "upstream_time": f"{log.upstream_response_time:.3f}" if log.upstream_response_time is not None else "",
            "request_raw": request,
        },
        separators=(",", ":"),
    )


class TrafficGenerator:
    """Yields batches of rows; every public row carries its visitor's fixed place and ASN."""

    def __init__(
        self,
        config: SeedConfig,
        visitors: list[Visitor],
        location_ids: dict[str, int],
        rng: random.Random,
    ) -> None:
        self.config = config
        self.rng = rng
        self.location_ids = location_ids
        self.public = [visitor for visitor in visitors if visitor.kind != "lan"]
        self.lan = [visitor for visitor in visitors if visitor.kind == "lan"]
        # Ranks follow list order, and the builder finds visitors of a subnet together.
        rng.shuffle(self.public)
        self._cum_weights = list(
            accumulate(
                KIND_WEIGHTS[visitor.kind] / (rank + 1) ** VISITOR_ZIPF_EXPONENT
                for rank, visitor in enumerate(self.public)
            )
        )
        self.servers = [(name, LOG_FORMATS[index % len(LOG_FORMATS)]) for index, name in enumerate(config.servers)]
        self._host_server = {host: self.servers[index % len(self.servers)] for index, host in enumerate(SITES)}

    def batches(self) -> Iterator[Batch]:
        remaining = self.config.rows
        while remaining > 0:
            size = min(self.config.batch_size, remaining)
            remaining -= size
            yield self._batch(size)

    def _batch(self, size: int) -> Batch:
        batch = Batch()
        picks = self.rng.choices(self.public, cum_weights=self._cum_weights, k=size)
        for visitor in picks:
            if self.lan and self.rng.random() < self.config.private_share:
                visitor = self.rng.choice(self.lan)
            self._add_request(batch, visitor)
        return batch

    def _add_request(self, batch: Batch, visitor: Visitor) -> None:
        rng = self.rng
        timestamp = datetime.fromtimestamp(self._timestamp(visitor), tz=timezone.utc)
        probe = visitor.kind == "scanner" and rng.random() < PROBE_SHARE
        log = self._probe_log(visitor, timestamp) if probe else self._request_log(visitor, timestamp)

        if probe:
            payload, reason = rng.choice(PROBES[log.log_format])
            batch.linked.append((log, debug_row_for(log, raw_line(log, payload), reason)))
        elif rng.random() < self.config.debug_share:
            request = f"{log.method} {log.url} {log.http_version}"
            batch.linked.append((log, debug_row_for(log, raw_line(log, request), None)))
        else:
            batch.access_logs.append(log)

        if visitor.resolved is not None:
            batch.geo_events.append(
                GeoEventRow(
                    timestamp=timestamp,
                    ip_address=visitor.ip,
                    server=log.server,
                    location_id=self.location_ids[visitor.resolved.place.geohash],
                    autonomous_system_number=visitor.resolved.asn,
                    autonomous_system_organization=visitor.resolved.asn_org,
                )
            )

        if rng.random() < UNPARSEABLE_SHARE:
            batch.orphan_debug.append(
                DebugRow(
                    access_log_id=None,
                    created_at=timestamp,
                    raw_line=rng.choice(UNPARSEABLE_LINES),
                    is_malformed=True,
                    parse_error=UNPARSEABLE_ERROR,
                    log_format=log.log_format,
                    log_timestamp=None,
                    ip_address=None,
                    method=None,
                    url=None,
                    host=None,
                    status_code=None,
                    country_code=None,
                    country_name=None,
                    city=None,
                    user_agent=None,
                )
            )

    def _timestamp(self, visitor: Visitor) -> float:
        low, high = visitor.active_from, visitor.active_to
        moment = self.rng.uniform(low, high)
        if visitor.kind not in ("browser", "lan"):
            return moment
        for _ in range(8):
            local_hour = int((moment / 3600 + visitor.utc_offset_hours) % 24)
            if self.rng.random() < DIURNAL[local_hour]:
                break
            moment = self.rng.uniform(low, high)
        return moment

    def _request_log(self, visitor: Visitor, timestamp: datetime) -> AccessLogRow:
        rng = self.rng
        referrer: str | None = None
        remote_user: str | None = None
        if visitor.kind == "scanner":
            host = rng.choice(visitor.hosts) if rng.random() < 0.6 else None
            method, url = pick_weighted(rng, SCANNER_REQUEST_OPTIONS)
            status = pick_weighted(rng, STATUSES["scanner"])
            http_version = "HTTP/1.1" if rng.random() < 0.9 else "HTTP/1.0"
        elif visitor.kind == "crawler":
            host = rng.choice(visitor.hosts)
            method = "GET"
            url = pick_weighted(rng, CRAWLER_PATHS) if rng.random() < 0.5 else pick_weighted(rng, SITES[host])
            status = pick_weighted(rng, STATUSES["crawler"])
            http_version = "HTTP/1.1" if rng.random() < 0.7 else "HTTP/2.0"
        else:
            host = rng.choice(visitor.hosts)
            method = pick_weighted(rng, BROWSER_METHODS)
            url = pick_weighted(rng, SITES[host])
            status = pick_weighted(rng, STATUSES["browser"])
            http_version = pick_weighted(rng, HTTP_VERSIONS)
            roll = rng.random()
            if roll < 0.25:
                referrer = f"https://{host}/"
            elif roll < 0.35:
                referrer = pick_weighted(rng, SEARCH_REFERRERS)
            if "/remote.php/dav/" in url:
                remote_user = "alex"

        server, log_format = self._host_server[host] if host else rng.choice(self.servers)
        request_time = round(min(30.0, rng.lognormvariate(-3.2, 1.1)), 3)
        if status == 504:
            request_time = 60.0
        unproxied = status in (444, 499) or (visitor.kind == "scanner" and status in (400, 403, 404, 405))
        upstream = None if unproxied else round(request_time * rng.uniform(0.6, 0.98), 3)
        resolved = visitor.resolved
        return AccessLogRow(
            timestamp=timestamp,
            ip_address=visitor.ip,
            remote_user=remote_user,
            method=method,
            url=url,
            http_version=http_version,
            status_code=status,
            bytes_sent=self._bytes_sent(method, status),
            referrer=referrer,
            user_agent=visitor.user_agent,
            request_time=request_time,
            upstream_response_time=upstream,
            host=host,
            country_code=resolved.place.country_code if resolved else None,
            country_name=resolved.place.country_name if resolved else None,
            city=resolved.place.city if resolved else None,
            autonomous_system_number=resolved.asn if resolved else None,
            autonomous_system_organization=resolved.asn_org if resolved else None,
            server=server,
            log_format=log_format,
        )

    def _probe_log(self, visitor: Visitor, timestamp: datetime) -> AccessLogRow:
        """A TLS/SSH/SMB probe: no method, URL or protocol, answered with a 400."""
        server, log_format = self.rng.choice(self.servers)
        resolved = visitor.resolved
        return AccessLogRow(
            timestamp=timestamp,
            ip_address=visitor.ip,
            remote_user=None,
            method=None,
            url=None,
            http_version=None,
            status_code=400,
            bytes_sent=self.rng.randint(150, 170),
            referrer=None,
            user_agent=None,
            request_time=round(self.rng.uniform(0.001, 0.4), 3),
            upstream_response_time=None,
            host=None,
            country_code=resolved.place.country_code if resolved else None,
            country_name=resolved.place.country_name if resolved else None,
            city=resolved.place.city if resolved else None,
            autonomous_system_number=resolved.asn if resolved else None,
            autonomous_system_organization=resolved.asn_org if resolved else None,
            server=server,
            log_format=log_format,
        )

    def _bytes_sent(self, method: str, status: int) -> int:
        if method == "HEAD" or status in (204, 304, 444, 499):
            return 0
        if status >= 400:
            return self.rng.randint(150, 600)
        if status in (301, 302):
            return self.rng.randint(160, 180)
        return min(50_000_000, int(self.rng.lognormvariate(8.5, 1.6)))

