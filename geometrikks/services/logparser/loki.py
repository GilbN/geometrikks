"""Read access-log lines from Grafana Loki instead of tailing a file.

A LokiParser is a LogParser whose lines come from a LogQL stream selector
rather than a file: format detection, parsing, GeoIP, ignore lists and peer
classification are the shared ones. It polls ``/loki/api/v1/query_range``
every ``poll_interval`` seconds for lines newer than the previous read.

Lines can reach Loki after newer ones (shipping agents batch, several
streams flush independently), so every read looks back ``lookback`` seconds
and skips the lines it has already yielded. Like a tailed file started at its
end, reading begins at startup: lines written while the app was down are not
replayed.

One selector can match several Loki streams (one per label set, for example
one per status code); their lines are merged back into timestamp order.
"""
from __future__ import annotations

import time
from collections.abc import AsyncGenerator

import httpx2
from geoip2.database import Reader

from geometrikks.lib.utils import sleep_unless_stopped
from geometrikks.server.logging import get_logger

from .logparser import LogParser, make_cached_asn_lookup, make_cached_city_lookup
from .schemas import ParsedLogRecord

logger = get_logger(__name__)

# Entries per query_range request; a busier window is paged through.
PAGE_LIMIT = 5000
NS = 1_000_000_000


def _now_ns() -> int:
    """Wall clock in nanoseconds, Loki's timestamp unit (patched in tests)."""
    return time.time_ns()


class LokiParser(LogParser):
    """Parses the lines of one LogQL stream selector, read from Loki."""

    tails_file = False

    def __init__(
        self,
        *,
        url: str,
        query: str,
        tenant_id: str | None = None,
        username: str | None = None,
        password: str | None = None,
        lookback: float = 60.0,
        timeout: float = 10.0,
        transport: httpx2.AsyncBaseTransport | None = None,
        **kwargs,
    ) -> None:
        """Set up the Loki source; other keyword arguments go to LogParser.

        Args:
            url: Loki base URL, e.g. http://loki:3100.
            query: LogQL stream selector, e.g. {job="nginx"}.
            tenant_id: Sent as X-Scope-OrgID when set.
            username: Basic auth username, with password.
            password: Basic auth password, with username.
            lookback: Seconds each read looks back for late lines.
            timeout: HTTP timeout in seconds.
            transport: HTTP transport override (tests).
        """
        super().__init__(log_path=f"loki:{query}", **kwargs)
        self.url = url.rstrip("/")
        self.query = query
        self.tenant_id = tenant_id
        self.auth = (username, password) if username is not None and password is not None else None
        self.lookback = lookback
        self.timeout = timeout
        self.transport = transport

    def _client(self) -> httpx2.AsyncClient:
        headers = {"X-Scope-OrgID": self.tenant_id} if self.tenant_id else {}
        return httpx2.AsyncClient(
            base_url=self.url,
            headers=headers,
            auth=self.auth,
            timeout=httpx2.Timeout(self.timeout),
            # A redirect could carry the basic auth header to another host.
            follow_redirects=False,
            transport=self.transport,
        )

    async def fetch(
        self, client: httpx2.AsyncClient, start_ns: int, end_ns: int
    ) -> list[tuple[int, str]]:
        """Every (timestamp_ns, line) in [start_ns, end_ns], oldest first.

        Raises:
            httpx2.HTTPError: Loki unreachable or answering an error status.
            ValueError: A response that is not a Loki streams result.
        """
        entries: set[tuple[int, str]] = set()
        cursor = start_ns
        while True:
            response = await client.get(
                "/loki/api/v1/query_range",
                params={
                    "query": self.query,
                    "start": str(cursor),
                    "end": str(end_ns),
                    "limit": str(PAGE_LIMIT),
                    "direction": "forward",
                },
            )
            response.raise_for_status()
            payload = response.json()
            try:
                result = payload["data"]["result"]
                page = sorted(
                    (int(value[0]), value[1])
                    for stream in result
                    for value in stream["values"]
                )
            except (KeyError, TypeError, IndexError) as exc:
                raise ValueError(f"unexpected Loki response: {exc!r}") from exc
            fresh = [entry for entry in page if entry not in entries]
            entries.update(fresh)
            if len(page) < PAGE_LIMIT or cursor >= end_ns:
                return sorted(entries)
            # A full page: resume at its last timestamp, which is read again
            # (the set drops the overlap). A full page with nothing new means
            # that one timestamp holds a whole page of lines; step past it
            # rather than ask for the same page forever.
            cursor = page[-1][0] if fresh else page[-1][0] + 1

    def _mark_unavailable(self, err: Exception) -> None:
        if not self.file_missing:
            logger.error("Loki source unavailable: %s (%s) - retrying", self.log_path, err)
            self.file_missing = True

    def _mark_available(self) -> None:
        if self.file_missing:
            logger.info("Loki source reachable again: %s", self.log_path)
            self.file_missing = False

    async def iter_parsed_records(
        self,
        reader: Reader,
        asn_reader: Reader | None = None,
        *,
        skip_validation: bool = False,
        start_at_end: bool = True,
    ) -> AsyncGenerator[ParsedLogRecord | None, None]:
        """Poll Loki and yield a ParsedLogRecord per new line.

        The format is detected from the first lines in auto mode, as
        ``parse_line`` does for files. ``skip_validation`` and
        ``start_at_end`` exist for signature compatibility: reading always
        starts at the current time.

        Yields:
            ParsedLogRecord per line; None on an idle poll, a failed read, or
            a line from an ignored IP.
        """
        lookup = make_cached_city_lookup(reader)
        asn_lookup = make_cached_asn_lookup(asn_reader) if asn_reader is not None else None
        lookback_ns = int(self.lookback * NS)
        floor = cursor = _now_ns()
        seen: dict[tuple[int, str], None] = {}
        logger.info("Streaming log events from Loki: %s", self.log_path)

        async with self._client() as client:
            while not (self._stop_event and self._stop_event.is_set()):
                now = _now_ns()
                try:
                    entries = await self.fetch(client, max(floor, cursor - lookback_ns), now)
                except (httpx2.HTTPError, ValueError) as exc:
                    self._mark_unavailable(exc)
                    yield None
                    if await sleep_unless_stopped(self.poll_interval, self._stop_event):
                        return
                    continue
                self._mark_available()
                cursor = now

                for entry in entries:
                    if entry in seen:
                        continue
                    seen[entry] = None
                    yield self.parse_line(entry[1], lookup, asn_lookup)

                # The next read starts at now - lookback; older keys cannot come back.
                cutoff = now - lookback_ns
                seen = {key: None for key in seen if key[0] >= cutoff}

                yield None
                if await sleep_unless_stopped(self.poll_interval, self._stop_event):
                    return
