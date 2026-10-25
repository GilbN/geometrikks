"""Pick the newest GitHub release that applies to the running build.

Tags look like v0.22.1 (stable) and v0.22.1-dev.1 (dev, marked prerelease on
GitHub). A stable build is only offered stable releases. A dev build is
offered every release, so it hears about the next dev tag and the stable one.
"""

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx2
import msgspec
from packaging.version import InvalidVersion, Version

from geometrikks.lib.versioning import is_local_build
from geometrikks.server.logging import get_logger
from geometrikks.services.rdap import USER_AGENT

logger = get_logger(__name__)

RELEASES_URL = "https://api.github.com/repos/GilbN/geometrikks/releases?per_page=30"
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 1024 * 1024
MIN_RELEASE_AGE = timedelta(hours=1)
GITHUB_URL_PREFIX = "https://github.com/"


class ReleaseCheckError(Exception):
    """A failed check. str(error) is the reason that gets logged."""


class ReleaseEntry(msgspec.Struct):
    tag_name: str
    draft: bool
    prerelease: bool
    html_url: str
    published_at: datetime | None = None


@dataclass(frozen=True)
class GithubRelease:
    version: Version
    prerelease: bool
    url: str
    published_at: datetime


def tag_version(tag: str) -> Version | None:
    """Parse a release tag: v0.22.1-dev.1 becomes 0.22.1.dev1."""
    normalized = tag.removeprefix("v").replace("-dev.", ".dev")
    try:
        return Version(normalized)
    except ValueError:
        # InvalidVersion is a ValueError, and so is the int digit limit that a
        # tag of thousands of digits trips
        return None


def parse_releases(body: bytes) -> list[GithubRelease]:
    try:
        release_entries = msgspec.json.decode(body, type=list[ReleaseEntry])
    except (msgspec.DecodeError, msgspec.ValidationError) as error:
        raise ReleaseCheckError("invalid response") from error

    github_releases: list[GithubRelease] = []
    for release_entry in release_entries:
        if release_entry.draft or release_entry.published_at is None:
            continue
        # a naive timestamp cannot be compared with an aware "now"
        if release_entry.published_at.tzinfo is None:
            continue
        # html_url ends up as an href in the SPA
        if not release_entry.html_url.startswith(GITHUB_URL_PREFIX):
            continue
        version = tag_version(release_entry.tag_name)
        if version is None:
            continue
        github_releases.append(
            GithubRelease(
                version=version,
                prerelease=release_entry.prerelease,
                url=release_entry.html_url,
                published_at=release_entry.published_at,
            )
        )
    return github_releases


def select_newer_release(
    github_releases: Sequence[GithubRelease], running_version: str, now: datetime
) -> GithubRelease | None:
    """The highest settled release above the running build, or None."""
    if is_local_build(running_version):
        return None
    try:
        parsed_running = Version(running_version)
    except InvalidVersion:
        return None

    running_public = Version(parsed_running.public)
    candidates = [
        github_release
        for github_release in github_releases
        if (parsed_running.is_prerelease or not github_release.prerelease)
        and now - github_release.published_at >= MIN_RELEASE_AGE
        and github_release.version > running_public
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda github_release: github_release.version)


def _utc_now() -> datetime:
    return datetime.now(UTC)


class ReleaseChecker:
    """Holds the newest applicable release and refreshes it from GitHub.

    Every failure keeps the last good answer, and run() never raises, so the
    scheduler has nothing to log. A failure is logged once per distinct reason
    until a check succeeds again.
    """

    def __init__(
        self,
        running_version: str,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._running_version = running_version
        self._transport = transport
        self._clock = clock
        self._github_releases: list[GithubRelease] = []
        self._latest: GithubRelease | None = None
        self._checked_at: datetime | None = None
        self._etag: str | None = None
        self._last_failure_reason: str | None = None
        self._run_lock = asyncio.Lock()

    @property
    def running_version(self) -> str:
        return self._running_version

    @property
    def latest(self) -> GithubRelease | None:
        return self._latest

    @property
    def checked_at(self) -> datetime | None:
        return self._checked_at

    @property
    def etag(self) -> str | None:
        return self._etag

    async def run(self) -> None:
        # a slower, older response must not overwrite a newer answer or ETag
        async with self._run_lock:
            try:
                await self._refresh()
            except ReleaseCheckError as error:
                self._record_failure(str(error))
            except Exception as error:
                self._record_failure(type(error).__name__)

    async def _refresh(self) -> None:
        request_headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        }
        if self._etag is not None:
            request_headers["If-None-Match"] = self._etag

        body = bytearray()
        try:
            async with httpx2.AsyncClient(
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=False,
                headers=request_headers,
                transport=self._transport,
            ) as client:
                async with client.stream("GET", RELEASES_URL) as response:
                    status_code = response.status_code
                    response_etag = response.headers.get("etag")
                    if status_code == 200:
                        async for chunk in response.aiter_bytes():
                            body += chunk
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise ReleaseCheckError("response too large")
        except httpx2.TimeoutException as error:
            raise ReleaseCheckError("timeout") from error
        except httpx2.HTTPError as error:
            raise ReleaseCheckError(type(error).__name__) from error

        github_releases = self._github_releases
        etag = self._etag
        if status_code == 200:
            github_releases = parse_releases(bytes(body))
            etag = response_etag
        elif status_code != 304:
            raise ReleaseCheckError(f"HTTP {status_code}")

        now = self._clock()
        previous_latest = self._latest
        latest = select_newer_release(github_releases, self._running_version, now)

        self._github_releases = github_releases
        self._etag = etag
        self._latest = latest
        self._checked_at = now
        self._last_failure_reason = None
        if self._latest is not None and (
            previous_latest is None or previous_latest.version != self._latest.version
        ):
            logger.info(
                "release_check_found",
                running_version=self._running_version,
                latest_version=str(self._latest.version),
            )

    def _record_failure(self, reason: str) -> None:
        if reason == self._last_failure_reason:
            return
        self._last_failure_reason = reason
        logger.info("release_check_failed", reason=reason)
