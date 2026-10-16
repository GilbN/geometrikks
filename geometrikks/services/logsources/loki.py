"""Read access-log lines from Grafana Loki by polling query_range.

A LokiSource is one LogQL stream selector. Every ``poll_interval`` seconds
it asks Loki for entries stamped between ``lookback`` seconds before the
newest line seen and now, never more than an hour back, and yields the ones
it has not yielded yet. Shippers batch and streams flush independently, so
a line can reach Loki after newer ones. The lookback is there to catch it.

Reading starts at startup, like a tailed file opened at its end. The floor
is GeoMetrikks's clock at ``wait_ready``. If that clock runs ahead of the
shipper's, lines the shipper stamps in the first seconds after startup fall
below it. After the first poll the window follows the newest line seen.

The shipper stamps each entry when it reads it, unless a pipeline stage
takes the timestamp from the line. The README tells users to drop that
stage when the line carries the request's start time. A request stamped
when it began but logged when it ended can land behind the window, and
query_range cannot ask for entries by arrival time.
"""
from __future__ import annotations

import asyncio
import contextlib
import heapq
import json
import time
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

import httpx2

from geometrikks.lib.utils import sleep_unless_stopped
from geometrikks.server.logging import get_logger

from .base import SourceStatus

logger = get_logger(__name__)

NS = 1_000_000_000
PAGE_LIMIT = 1000
# A quiet selector must not grow the window until Loki refuses the query length.
MAX_WINDOW_SECONDS = 3600
TIMEOUT_SECONDS = 10.0
# How far back recent_lines samples. A proxy that has been quiet for an hour
# still gives the format check something to judge.
SAMPLE_WINDOW_SECONDS = 24 * 3600
QUERY_RANGE_PATH = "/loki/api/v1/query_range"

# (timestamp_ns, stream labels serialized in sorted order, line)
Entry = tuple[int, str, str]


class LokiRejected(Exception):
    """Loki answered, but the query or the response cannot be used as a log source."""


def _now_ns() -> int:
    """Wall clock in nanoseconds, Loki's timestamp unit (patched in tests)."""
    return time.time_ns()


def _stream_key(labels: object) -> str:
    if not isinstance(labels, dict):
        raise LokiRejected("stream labels are not an object")
    return json.dumps(labels, sort_keys=True, separators=(",", ":"))


def _parse_entries(payload: object) -> list[Entry]:
    """The entries of a query_range response, oldest first.

    Raises:
        LokiRejected: not a successful streams result, or an entry that is
            not a [timestamp, line] pair with a non-negative integer timestamp.
    """
    if not isinstance(payload, dict) or payload.get("status") != "success":
        raise LokiRejected("response status is not success")
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("resultType") != "streams":
        result_type = data.get("resultType") if isinstance(data, dict) else None
        raise LokiRejected(f"resultType is {result_type!r}, not streams (is this a metric query?)")
    result = data.get("result")
    if not isinstance(result, list):
        raise LokiRejected("result is not a list of streams")
    entries: list[Entry] = []
    for stream in result:
        if not isinstance(stream, dict):
            raise LokiRejected("stream is not an object")
        key = _stream_key(stream.get("stream"))
        values = stream.get("values")
        if not isinstance(values, list):
            raise LokiRejected("stream values are not a list")
        for value in values:
            if not (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and isinstance(value[1], str)
            ):
                raise LokiRejected("entry is not a [timestamp, line] pair")
            timestamp = value[0]
            # An int64 of nanoseconds has at most 19 digits. A longer string would
            # also hit CPython's int-conversion length limit and raise ValueError.
            if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 19):
                raise LokiRejected(f"timestamp {timestamp[:40]!r} is not a non-negative int64")
            entries.append((int(timestamp), key, value[1]))
    entries.sort()
    return entries


class LokiSource:
    """One LogQL stream selector, read by polling query_range."""

    kind = "loki"

    def __init__(
        self,
        *,
        url: str,
        query: str,
        label: str,
        hostname: str = "",
        tenant_id: str | None = None,
        username: str | None = None,
        password: str | None = None,
        poll_interval: float = 5.0,
        lookback: float = 60.0,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """Set up the source.

        Args:
            url: Loki base URL, e.g. http://loki:3100. A path prefix is kept.
            query: LogQL stream selector, e.g. {job="nginx"}.
            label: Opaque name served on /health, e.g. loki:1. The selector
                describes the operator's log setup and stays off the
                unauthenticated endpoint.
            hostname: Stamped on every record read from this source.
            tenant_id: Sent as X-Scope-OrgID when set.
            username: Basic auth username, with password.
            password: Basic auth password, with username.
            poll_interval: Seconds between reads.
            lookback: Seconds each read looks back for late lines.
            transport: HTTP transport override (tests).
        """
        self.url: str = url.rstrip("/")
        self.query: str = query
        self.label: str = label
        self.hostname: str = hostname
        self.poll_interval: float = poll_interval
        self.lookback: float = lookback
        self.tenant_id: str | None = tenant_id
        self._auth = (
            (username, password) if username is not None and password is not None else None
        )
        self._transport = transport
        # "unreachable" or "rejected" while Loki cannot be read, None while
        # it can. Surfaced through LogIngestionService.unavailable_sources
        # into /health.
        self._unavailable_reason: str | None = None
        # The clock when wait_ready returned. lines() starts there, so lines
        # stamped while the service was checking the format are not skipped.
        # None means "start at the clock now".
        self._ready_at: int | None = None
        # Crowded timestamps already warned about. The lookback re-reads them on
        # every poll, and a late batch can crowd a timestamp below one already
        # warned. lines() prunes it with the dedup set.
        self._warned_timestamps: set[int] = set()

    def status(self) -> SourceStatus:
        if self._unavailable_reason is not None:
            return SourceStatus(available=False, reason=self._unavailable_reason)
        return SourceStatus(available=True)

    async def wait_ready(self, stop: asyncio.Event) -> bool:
        # There is nothing to wait for. status() reports an unreachable Loki and
        # lines() keeps retrying it, as FileSource does with a vanished file.
        self._ready_at = _now_ns()
        return True

    def _client(self) -> httpx2.AsyncClient:
        headers = {"X-Scope-OrgID": self.tenant_id} if self.tenant_id else {}
        return httpx2.AsyncClient(
            base_url=self.url,
            headers=headers,
            auth=self._auth,
            timeout=httpx2.Timeout(TIMEOUT_SECONDS),
            # A redirect could carry the basic auth header to another host.
            follow_redirects=False,
            transport=self._transport,
        )

    def _mark(self, reason: str | None, detail: str = "") -> None:
        """Record availability, logging each change once."""
        if reason == self._unavailable_reason:
            return
        if reason is None:
            logger.info("loki_source_available", label=self.label, query=self.query)
        elif reason == "unreachable":
            logger.error(
                "loki_source_unreachable", label=self.label, query=self.query, detail=detail
            )
        else:
            logger.error(
                "loki_source_rejected",
                label=self.label,
                query=self.query,
                detail=detail,
                hint="Loki answered but refused the request. Check LOKI_URL, LOKI_QUERIES and the credentials.",
            )
        self._unavailable_reason = reason

    async def _request(self, client: httpx2.AsyncClient, params: dict[str, str]) -> list[Entry]:
        """One query_range request, parsed.

        Raises:
            httpx2.HTTPError: Loki unreachable, timed out, 5xx or 429 (retry).
            LokiRejected: any other non-200 answer, or a body that is not a
                streams result (configuration, not an outage).
        """
        response = await client.get(QUERY_RANGE_PATH, params=params)
        if response.status_code >= 500 or response.status_code == 429:
            response.raise_for_status()
        if response.status_code != 200:
            raise LokiRejected(f"HTTP {response.status_code}")
        try:
            payload: Any = response.json()
        except ValueError as exc:
            raise LokiRejected("response is not JSON") from exc
        return _parse_entries(payload)

    async def recent_lines(self, count: int) -> list[str]:
        if count <= 0:
            return []
        params = {
            "query": self.query,
            "start": str(_now_ns() - SAMPLE_WINDOW_SECONDS * NS),
            "limit": str(count),
            "direction": "backward",
        }
        async with self._client() as client:
            try:
                entries = await self._request(client, params)
            except httpx2.HTTPError as exc:
                self._mark("unreachable", repr(exc))
                return []
            except LokiRejected as exc:
                self._mark("rejected", str(exc))
                return []
        # A source restarted in-process can still carry the flag from before
        # it stopped, and format validation trusts it.
        self._mark(None)
        return [line for _, _, line in entries]

    async def _pages(
        self,
        client: httpx2.AsyncClient,
        start_ns: int,
        end_ns: int,
        stop: asyncio.Event,
    ) -> AsyncGenerator[list[Entry], None]:
        """Pages of entries stamped in [start_ns, end_ns), oldest first.

        Loki's ``start`` is inclusive, so each page after the first is asked
        from the previous page's last timestamp and the caller's dedup drops
        the overlap. A short page, a cursor at or past ``end_ns`` or a stop
        request ends the poll. The first request always goes out, even when
        the window is empty, so an idle source still proves Loki answers.

        Raises:
            httpx2.HTTPError, LokiRejected: as ``_request``.
        """
        cursor = start_ns
        while True:
            page = await self._request(
                client,
                {
                    "query": self.query,
                    "start": str(cursor),
                    "end": str(end_ns),
                    "limit": str(PAGE_LIMIT),
                    "direction": "forward",
                },
            )
            yield page
            if len(page) < PAGE_LIMIT or stop.is_set():
                return
            last = page[-1][0]
            if page[0][0] != last:
                cursor = last
            else:
                # query_range has no cursor inside a timestamp, so a full page
                # at one nanosecond cannot be paged. Step past it and lose the
                # rest of that nanosecond.
                if last not in self._warned_timestamps:
                    logger.warning(
                        "More than %d lines in %s share the timestamp %s, and GeoMetrikks "
                        "skipped all but the first %d. The log pipeline sets the entry "
                        "timestamp from a line with second precision. Remove that stage so "
                        "the shipper stamps each line when it reads it. See \"Reading from "
                        "Loki\" in the README.",
                        PAGE_LIMIT,
                        self.query,
                        datetime.fromtimestamp(last / NS, tz=timezone.utc).isoformat(),
                        PAGE_LIMIT,
                    )
                    self._warned_timestamps.add(last)
                cursor = last + 1
            if cursor >= end_ns:
                return

    async def read_range(
        self, start_ns: int, end_ns: int
    ) -> AsyncGenerator[list[Entry], None]:
        """Pages of entries stamped in [start_ns, end_ns), oldest first.

        For import-loki. Owns its client. Unlike lines(), nothing is
        retried or recorded in status(): the importer stops at the window
        it was reading and the next run resumes there.

        Raises:
            httpx2.HTTPError, LokiRejected: as ``_request``.
        """
        async with self._client() as client:
            async with contextlib.aclosing(
                self._pages(client, start_ns, end_ns, asyncio.Event())
            ) as pages:
                async for page in pages:
                    yield page

    async def lines(self, stop: asyncio.Event) -> AsyncGenerator[str, None]:
        """Poll Loki until stop is set, yielding each new line once.

        ``floor`` is the clock wait_ready recorded, or the clock now. Entries
        stamped before it are never yielded, like lines before the end of a
        tailed file. ``newest`` is the largest timestamp seen so far and
        bounds the start of the next window, which reaches back at most
        MAX_WINDOW_SECONDS; the end is the clock at each poll, so one poll
        covers a fixed window and always finishes.
        """
        lookback_ns = int(self.lookback * NS)
        max_window_ns = MAX_WINDOW_SECONDS * NS
        floor = newest = self._ready_at if self._ready_at is not None else _now_ns()
        self._ready_at = None
        # Window starts only move forward, so a clock step back cannot reach
        # below what was pruned from seen.
        last_start = floor
        seen: set[Entry] = set()
        # The same entries as seen, oldest first, so pruning pops only what expires.
        seen_by_age: list[Entry] = []
        logger.info("loki_source_streaming", label=self.label, query=self.query)
        async with self._client() as client:
            while not stop.is_set():
                end = _now_ns()
                start = max(last_start, newest - lookback_ns, end - max_window_ns)
                # A clock that stepped back past the window start would get a 400.
                if end >= start:
                    last_start = start
                    try:
                        async with contextlib.aclosing(
                            self._pages(client, start, end, stop)
                        ) as pages:
                            async for page in pages:
                                for entry in page:
                                    if entry in seen:
                                        continue
                                    seen.add(entry)
                                    heapq.heappush(seen_by_age, entry)
                                    yield entry[2]
                                if page:
                                    newest = max(newest, page[-1][0])
                                # Later pages start at this page's last timestamp,
                                # so nothing older than the cutoff can come back.
                                last_start = max(last_start, newest - lookback_ns)
                                while seen_by_age and seen_by_age[0][0] < last_start:
                                    seen.discard(heapq.heappop(seen_by_age))
                                self._warned_timestamps = {
                                    stamp for stamp in self._warned_timestamps if stamp >= last_start
                                }
                    except httpx2.HTTPError as exc:
                        self._mark("unreachable", repr(exc))
                    except LokiRejected as exc:
                        self._mark("rejected", str(exc))
                    else:
                        self._mark(None)
                if await sleep_unless_stopped(self.poll_interval, stop):
                    return
