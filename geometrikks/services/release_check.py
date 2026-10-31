"""Pick the newest GitHub release that applies to the running build.

Tags look like v0.22.1 (stable) and v0.22.1-dev.1 (dev, marked prerelease on
GitHub). A stable build is only offered stable releases. A dev build is
offered every release, so it hears about the next dev tag and the stable one.
"""

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import httpx2
import msgspec
from packaging.version import InvalidVersion, Version

from geometrikks.lib.outbound import USER_AGENT
from geometrikks.lib.versioning import is_local_build
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from geometrikks.config.settings import Settings

logger = get_logger(__name__)

RELEASES_PAGE_SIZE = 30
RELEASES_URL = (
    f"https://api.github.com/repos/GilbN/geometrikks/releases?per_page={RELEASES_PAGE_SIZE}"
)
# Ten pages reach back 300 releases; an install further behind gets an "or more" count.
MAX_RELEASE_PAGES = 10
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 1024 * 1024
MIN_RELEASE_AGE = timedelta(minutes=15)
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


def decode_release_entries(body: bytes) -> list[ReleaseEntry]:
    try:
        return msgspec.json.decode(body, type=list[ReleaseEntry])
    except (msgspec.DecodeError, msgspec.ValidationError) as error:
        raise ReleaseCheckError("invalid response") from error


def parse_releases(body: bytes) -> list[GithubRelease]:
    return releases_from_entries(decode_release_entries(body))


def releases_from_entries(release_entries: Sequence[ReleaseEntry]) -> list[GithubRelease]:
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


def newer_releases(
    github_releases: Sequence[GithubRelease], running_version: str, now: datetime
) -> list[GithubRelease]:
    """Every settled release above the running build that applies to it, newest first."""
    if is_local_build(running_version):
        return []
    try:
        parsed_running = Version(running_version)
    except InvalidVersion:
        return []

    running_public = Version(parsed_running.public)
    candidates = [
        github_release
        for github_release in github_releases
        if (
            parsed_running.is_prerelease
            or not (github_release.prerelease or github_release.version.is_prerelease)
        )
        and now - github_release.published_at >= MIN_RELEASE_AGE
        and github_release.version > running_public
    ]
    return sorted(candidates, key=lambda github_release: github_release.version, reverse=True)


def newer_count_is_exact(
    github_releases: Sequence[GithubRelease], running_version: str, *, page_full: bool
) -> bool:
    """Whether the pages fetched so far hold every release above the running build.

    GitHub lists releases newest first by creation date, so the next page holds
    only releases created before the oldest one fetched. Once that one is at or
    below the running version, the next page is too, as long as releases go out
    in version order. A patch for an older line published after a newer release
    breaks that, and the count can then miss releases further back.
    """
    if not page_full:
        return True
    if not github_releases:
        return False
    try:
        running_public = Version(Version(running_version).public)
    except InvalidVersion:
        return True
    return github_releases[-1].version <= running_public


def select_newer_release(
    github_releases: Sequence[GithubRelease], running_version: str, now: datetime
) -> GithubRelease | None:
    """The highest settled release above the running build, or None."""
    candidates = newer_releases(github_releases, running_version, now)
    return candidates[0] if candidates else None


async def _fetch_page(
    client: httpx2.AsyncClient, url: str, etag: str | None
) -> tuple[int, str | None, bytes]:
    """GET one page of releases: status, ETag and, for a 200, the capped body."""
    headers = {"If-None-Match": etag} if etag is not None else {}
    body = bytearray()
    async with client.stream("GET", url, headers=headers) as response:
        if response.status_code == 200:
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ReleaseCheckError("response too large")
        return response.status_code, response.headers.get("etag"), bytes(body)


def release_check_enabled(settings: "Settings") -> bool:
    """Whether this process should poll GitHub for a newer release."""
    if not settings.app.update_check or not settings.scheduler.enabled or settings.is_agent:
        return False
    if is_local_build(settings.version):
        return False
    try:
        Version(settings.version)
    except InvalidVersion:
        return False
    return True


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
        self._first_page_releases: list[GithubRelease] = []
        self._first_page_full = False
        self._latest: GithubRelease | None = None
        self._newer_release_count = 0
        self._newer_release_count_exact = True
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
    def newer_release_count(self) -> int:
        """How many releases above the running one apply to it, the latest included."""
        return self._newer_release_count

    @property
    def newer_release_count_exact(self) -> bool:
        """False when the pages fetched stopped short of the running version."""
        return self._newer_release_count_exact

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
                self._record_failure(type(error).__name__, exc_info=error)

    async def _refresh(self) -> None:
        request_headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        }
        first_page_releases = self._first_page_releases
        first_page_full = self._first_page_full
        etag = self._etag
        try:
            async with httpx2.AsyncClient(
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=False,
                headers=request_headers,
                transport=self._transport,
            ) as client:
                # The ETag covers only the page it came with. A 304 spares the
                # first page, and the later ones get fetched again every run.
                status_code, response_etag, body = await _fetch_page(
                    client, RELEASES_URL, self._etag
                )
                if status_code == 200:
                    release_entries = decode_release_entries(body)
                    first_page_releases = releases_from_entries(release_entries)
                    first_page_full = len(release_entries) >= RELEASES_PAGE_SIZE
                    etag = response_etag
                elif status_code != 304:
                    raise ReleaseCheckError(f"HTTP {status_code}")

                github_releases = first_page_releases
                last_page_full = first_page_full
                page_number = 1
                while page_number < MAX_RELEASE_PAGES and not newer_count_is_exact(
                    github_releases, self._running_version, page_full=last_page_full
                ):
                    page_number += 1
                    status_code, _, body = await _fetch_page(
                        client, f"{RELEASES_URL}&page={page_number}", None
                    )
                    if status_code != 200:
                        raise ReleaseCheckError(f"HTTP {status_code}")
                    release_entries = decode_release_entries(body)
                    # a release published between two requests pushes the last
                    # one of the previous page onto this one
                    seen_urls = {github_release.url for github_release in github_releases}
                    github_releases = github_releases + [
                        github_release
                        for github_release in releases_from_entries(release_entries)
                        if github_release.url not in seen_urls
                    ]
                    last_page_full = len(release_entries) >= RELEASES_PAGE_SIZE
        except httpx2.TimeoutException as error:
            raise ReleaseCheckError("timeout") from error
        except httpx2.HTTPError as error:
            raise ReleaseCheckError(type(error).__name__) from error

        now = self._clock()
        previous_latest = self._latest
        candidates = newer_releases(github_releases, self._running_version, now)

        self._first_page_releases = first_page_releases
        self._first_page_full = first_page_full
        self._etag = etag
        self._latest = candidates[0] if candidates else None
        self._newer_release_count = len(candidates)
        self._newer_release_count_exact = newer_count_is_exact(
            github_releases, self._running_version, page_full=last_page_full
        )
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

    def _record_failure(self, reason: str, *, exc_info: BaseException | None = None) -> None:
        if reason == self._last_failure_reason:
            return
        self._last_failure_reason = reason
        if exc_info is None:
            logger.info("release_check_failed", reason=reason)
        else:
            logger.info("release_check_failed", reason=reason, exc_info=exc_info)
