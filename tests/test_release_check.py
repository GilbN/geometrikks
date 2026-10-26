import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
import structlog.testing
from packaging.version import Version

from geometrikks.services.rdap import USER_AGENT
from geometrikks.services.release_check import (
    MAX_RESPONSE_BYTES,
    RELEASES_URL,
    GithubRelease,
    ReleaseCheckError,
    ReleaseChecker,
    parse_releases,
    select_newer_release,
    tag_version,
)

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
HOURS_AGO_2 = NOW - timedelta(hours=2)


def make_release(
    tag: str, *, prerelease: bool = False, published_at: datetime = HOURS_AGO_2
) -> GithubRelease:
    version = tag_version(tag)
    assert version is not None
    return GithubRelease(
        version=version,
        prerelease=prerelease,
        url=f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
        published_at=published_at,
    )


def test_tag_version_normalizes_dev_tags() -> None:
    assert tag_version("v0.22.1-dev.1") == Version("0.22.1.dev1")
    assert tag_version("v0.23.0") == Version("0.23.0")
    assert tag_version("nightly") is None


def test_stable_build_ignores_prereleases() -> None:
    dev_release = make_release("v0.22.1-dev.1", prerelease=True)
    assert select_newer_release([dev_release], "0.22.0", NOW) is None

    stable_release = make_release("v0.22.1")
    selected = select_newer_release([dev_release, stable_release], "0.22.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.22.1")


def test_stable_build_ignores_a_dev_tag_published_without_the_prerelease_flag() -> None:
    unflagged_dev_release = make_release("v0.23.0-dev.1", prerelease=False)
    assert select_newer_release([unflagged_dev_release], "0.22.0", NOW) is None


def test_dev_build_sees_a_dev_tag_published_without_the_prerelease_flag() -> None:
    unflagged_dev_release = make_release("v0.23.0-dev.1", prerelease=False)
    selected = select_newer_release([unflagged_dev_release], "0.22.1.dev1+g1234", NOW)
    assert selected == unflagged_dev_release


def test_dev_build_sees_a_newer_dev_prerelease() -> None:
    github_release = make_release("v0.22.1-dev.2", prerelease=True)
    selected = select_newer_release([github_release], "0.22.1.dev1+g1234", NOW)
    assert selected == github_release


def test_dev_build_sees_a_newer_stable_release() -> None:
    github_release = make_release("v0.22.1")
    selected = select_newer_release([github_release], "0.22.1.dev1+g1234", NOW)
    assert selected == github_release


def test_equal_version_is_not_newer() -> None:
    dev_release = make_release("v0.22.1-dev.1", prerelease=True)
    assert select_newer_release([dev_release], "0.22.1.dev1+g1234", NOW) is None
    stable_release = make_release("v0.22.1")
    assert select_newer_release([stable_release], "0.22.1", NOW) is None


@pytest.mark.parametrize("running_version", ["0.0.0+local", "unknown"])
def test_local_build_never_checks(running_version: str) -> None:
    assert select_newer_release([make_release("v0.23.0")], running_version, NOW) is None


def test_unparseable_running_version_selects_nothing() -> None:
    assert select_newer_release([make_release("v0.23.0")], "custom", NOW) is None


def test_release_younger_than_an_hour_does_not_count() -> None:
    older_release = make_release("v0.22.1")
    fresh_release = make_release("v0.23.0", published_at=NOW - timedelta(minutes=59))
    selected = select_newer_release([fresh_release, older_release], "0.22.0", NOW)
    assert selected == older_release

    boundary_release = make_release("v0.23.0", published_at=NOW - timedelta(hours=1))
    selected = select_newer_release([boundary_release, older_release], "0.22.0", NOW)
    assert selected == boundary_release

    settled_release = make_release("v0.23.0", published_at=NOW - timedelta(minutes=61))
    selected = select_newer_release([settled_release, older_release], "0.22.0", NOW)
    assert selected == settled_release


def test_out_of_order_list_picks_the_highest_version() -> None:
    github_releases = [make_release("v0.22.0"), make_release("v0.23.0"), make_release("v0.22.1")]
    selected = select_newer_release(github_releases, "0.21.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.23.0")


def test_parse_skips_drafts_unparseable_tags_and_foreign_urls() -> None:
    def entry(
        tag: str,
        *,
        draft: bool = False,
        url: str | None = None,
        published_at: str | None = "2026-10-25T08:00:00Z",
    ) -> dict:
        return {
            "tag_name": tag,
            "draft": draft,
            "prerelease": False,
            "html_url": url or f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
            "published_at": published_at,
            "name": tag,
        }

    body = json.dumps(
        [
            entry("v0.24.0", draft=True),
            entry("nightly"),
            entry("v0.23.1", url="https://example.com/x"),
            entry("v0.23.2", published_at=None),
            entry("v0.23.0"),
        ]
    ).encode()

    github_releases = parse_releases(body)

    assert len(github_releases) == 1
    assert github_releases[0].version == Version("0.23.0")
    assert github_releases[0].url == "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0"


@pytest.mark.parametrize("body", [b"not json", b'{"message": "API rate limit exceeded"}'])
def test_parse_rejects_a_body_that_is_not_a_release_list(body: bytes) -> None:
    with pytest.raises(ReleaseCheckError) as error:
        parse_releases(body)
    assert str(error.value) == "invalid response"


def test_parse_skips_a_release_published_without_a_timezone() -> None:
    def entry(tag: str, published_at: str) -> dict:
        return {
            "tag_name": tag,
            "draft": False,
            "prerelease": False,
            "html_url": f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
            "published_at": published_at,
        }

    body = json.dumps(
        [entry("v0.23.1", "2026-10-25T08:00:00"), entry("v0.23.0", "2026-10-25T08:00:00Z")]
    ).encode()

    github_releases = parse_releases(body)

    assert [github_release.version for github_release in github_releases] == [Version("0.23.0")]
    selected = select_newer_release(github_releases, "0.22.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.23.0")


def test_parse_fails_the_whole_response_when_one_entry_is_malformed() -> None:
    valid_entry = {
        "tag_name": "v0.23.0",
        "draft": False,
        "prerelease": False,
        "html_url": "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0",
        "published_at": "2026-10-25T08:00:00Z",
    }
    missing_tag_entry = {key: value for key, value in valid_entry.items() if key != "tag_name"}

    with pytest.raises(ReleaseCheckError) as error:
        parse_releases(json.dumps([valid_entry, missing_tag_entry]).encode())
    assert str(error.value) == "invalid response"


def release_body(tag: str = "v0.23.0", *, published_at: datetime = HOURS_AGO_2) -> bytes:
    return json.dumps(
        [
            {
                "tag_name": tag,
                "draft": False,
                "prerelease": False,
                "html_url": f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
                "published_at": published_at.isoformat().replace("+00:00", "Z"),
            }
        ]
    ).encode()


class FakeGithub:
    """Hands out canned answers in order and records every request."""

    def __init__(self, *answers: httpx2.Response | Exception) -> None:
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def checker(
        self, clock: Callable[[], datetime] = lambda: NOW, running_version: str = "0.22.0"
    ) -> ReleaseChecker:
        return ReleaseChecker(
            running_version, transport=httpx2.MockTransport(self.handle), clock=clock
        )


def releases_response(
    tag: str = "v0.23.0", *, etag: str | None = None, published_at: datetime = HOURS_AGO_2
) -> httpx2.Response:
    headers = {"ETag": etag} if etag else {}
    return httpx2.Response(200, content=release_body(tag, published_at=published_at), headers=headers)


class MutableClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.mark.anyio
async def test_request_carries_only_the_fixed_headers() -> None:
    fake_github = FakeGithub(releases_response())

    await fake_github.checker().run()

    request = fake_github.requests[0]
    assert str(request.url) == RELEASES_URL
    assert request.headers["accept"] == "application/vnd.github+json"
    assert request.headers["x-github-api-version"] == "2022-11-28"
    assert request.headers["user-agent"] == USER_AGENT
    assert "if-none-match" not in request.headers
    assert "authorization" not in request.headers


@pytest.mark.anyio
async def test_first_fetch_stores_the_etag() -> None:
    fake_github = FakeGithub(releases_response(etag='W/"abc"'), httpx2.Response(304))
    release_checker = fake_github.checker()

    await release_checker.run()

    assert release_checker.etag == 'W/"abc"'
    assert release_checker.latest is not None
    assert release_checker.latest.version == Version("0.23.0")
    assert release_checker.checked_at == NOW

    await release_checker.run()

    assert fake_github.requests[1].headers["if-none-match"] == 'W/"abc"'


@pytest.mark.anyio
async def test_not_modified_keeps_the_answer() -> None:
    clock = MutableClock(NOW)
    fake_github = FakeGithub(releases_response(etag='"one"'), httpx2.Response(304))
    release_checker = fake_github.checker(clock)
    await release_checker.run()
    first_latest = release_checker.latest

    clock.now = NOW + timedelta(hours=12)
    await release_checker.run()

    assert release_checker.latest == first_latest
    assert release_checker.checked_at == NOW + timedelta(hours=12)
    assert release_checker.etag == '"one"'


@pytest.mark.anyio
async def test_not_modified_lets_a_fresh_release_count_later() -> None:
    clock = MutableClock(NOW)
    published_at = NOW - timedelta(minutes=30)
    fake_github = FakeGithub(
        releases_response(etag='"one"', published_at=published_at), httpx2.Response(304)
    )
    release_checker = fake_github.checker(clock)

    await release_checker.run()
    assert release_checker.latest is None

    clock.now = NOW + timedelta(hours=12)
    await release_checker.run()

    assert release_checker.latest is not None
    assert release_checker.latest.version == Version("0.23.0")


@pytest.mark.anyio
async def test_timeout_keeps_the_last_good_answer_and_logs_once() -> None:
    clock = MutableClock(NOW)
    fake_github = FakeGithub(releases_response(etag='"one"'), httpx2.ReadTimeout("slow"))
    release_checker = fake_github.checker(clock)
    await release_checker.run()
    first_latest = release_checker.latest

    clock.now = NOW + timedelta(hours=12)
    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    assert release_checker.latest == first_latest
    assert release_checker.checked_at == NOW
    assert release_checker.etag == '"one"'
    failures = [log for log in logs if log["event"] == "release_check_failed"]
    assert failures == [{"event": "release_check_failed", "reason": "timeout", "log_level": "info"}]


@pytest.mark.anyio
async def test_repeated_failure_logs_nothing_new() -> None:
    fake_github = FakeGithub(
        httpx2.ReadTimeout("slow"),
        httpx2.ConnectTimeout("slow"),
        httpx2.Response(500),
        releases_response(),
        httpx2.ReadTimeout("slow"),
    )
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()
        await release_checker.run()
        reasons_after_two_timeouts = [
            log["reason"] for log in logs if log["event"] == "release_check_failed"
        ]
        await release_checker.run()
        await release_checker.run()
        await release_checker.run()

    assert reasons_after_two_timeouts == ["timeout"]
    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "timeout",
        "HTTP 500",
        "timeout",
    ]


@pytest.mark.anyio
async def test_other_transport_errors_are_logged_by_class_name() -> None:
    fake_github = FakeGithub(httpx2.ConnectError("refused"))
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "ConnectError"
    ]


@pytest.mark.anyio
async def test_rate_limited_answer_is_one_quiet_failure() -> None:
    fake_github = FakeGithub(
        releases_response(etag='"one"'),
        httpx2.Response(403),
        httpx2.Response(403),
        httpx2.Response(429),
    )
    release_checker = fake_github.checker()
    await release_checker.run()
    first_latest = release_checker.latest

    with structlog.testing.capture_logs() as logs:
        for _ in range(3):
            await release_checker.run()

    assert release_checker.latest == first_latest
    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "HTTP 403",
        "HTTP 429",
    ]
    assert all("exc_info" not in log for log in logs if log["event"] == "release_check_failed")
    assert len(fake_github.requests) == 4


@pytest.mark.anyio
async def test_body_over_the_cap_fails_without_reading_past_it() -> None:
    chunk_size = 256 * 1024
    chunks_sent = 0

    async def endless_chunks():
        nonlocal chunks_sent
        for _ in range(100):
            chunks_sent += 1
            yield b" " * chunk_size

    fake_github = FakeGithub(httpx2.Response(200, content=endless_chunks()))
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "response too large"
    ]
    assert chunks_sent <= MAX_RESPONSE_BYTES // chunk_size + 1
    assert release_checker.latest is None
    assert release_checker.checked_at is None


@pytest.mark.anyio
async def test_body_that_is_not_a_release_list_fails() -> None:
    fake_github = FakeGithub(httpx2.Response(200, content=b'{"message": "nope"}'))
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "invalid response"
    ]
    assert release_checker.checked_at is None


@pytest.mark.anyio
async def test_redirect_is_a_failure() -> None:
    fake_github = FakeGithub(
        httpx2.Response(302, headers={"Location": "https://api.github.com/elsewhere"})
    )
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    assert [log["reason"] for log in logs if log["event"] == "release_check_failed"] == [
        "HTTP 302"
    ]
    assert len(fake_github.requests) == 1


@pytest.mark.anyio
async def test_found_logs_when_the_answer_changes() -> None:
    fake_github = FakeGithub(releases_response(), releases_response())
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()
        await release_checker.run()

    assert [log for log in logs if log["event"] == "release_check_found"] == [
        {
            "event": "release_check_found",
            "running_version": "0.22.0",
            "latest_version": "0.23.0",
            "log_level": "info",
        }
    ]


@pytest.mark.anyio
async def test_found_logs_again_when_a_newer_release_appears() -> None:
    fake_github = FakeGithub(releases_response("v0.23.0"), releases_response("v0.24.0"))
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()
        await release_checker.run()

    assert [log["latest_version"] for log in logs if log["event"] == "release_check_found"] == [
        "0.23.0",
        "0.24.0",
    ]


@pytest.mark.anyio
async def test_malformed_body_after_a_success_changes_nothing() -> None:
    clock = MutableClock(NOW)
    fake_github = FakeGithub(
        releases_response(etag='"good"'),
        httpx2.Response(200, content=b"not json", headers={"ETag": '"bad"'}),
        httpx2.Response(304),
    )
    release_checker = fake_github.checker(clock)
    await release_checker.run()
    first_latest = release_checker.latest

    clock.now = NOW + timedelta(hours=12)
    await release_checker.run()

    assert release_checker.latest == first_latest
    assert release_checker.checked_at == NOW
    assert release_checker.etag == '"good"'

    await release_checker.run()

    assert fake_github.requests[2].headers["if-none-match"] == '"good"'


@pytest.mark.anyio
async def test_response_without_an_etag_clears_the_stored_one() -> None:
    fake_github = FakeGithub(
        releases_response(etag='"one"'), releases_response(), releases_response()
    )
    release_checker = fake_github.checker()
    await release_checker.run()

    await release_checker.run()

    assert fake_github.requests[1].headers["if-none-match"] == '"one"'
    assert release_checker.etag is None

    await release_checker.run()

    assert "if-none-match" not in fake_github.requests[2].headers


@pytest.mark.anyio
async def test_a_tag_with_thousands_of_digits_is_skipped() -> None:
    huge_tag = "v" + "9" * 5000
    assert tag_version(huge_tag) is None

    body = json.dumps(
        [
            {
                "tag_name": huge_tag,
                "draft": False,
                "prerelease": False,
                "html_url": "https://github.com/GilbN/geometrikks/releases/tag/huge",
                "published_at": "2026-10-25T08:00:00Z",
            }
        ]
    ).encode()
    fake_github = FakeGithub(httpx2.Response(200, content=body))
    release_checker = fake_github.checker()

    await release_checker.run()

    assert release_checker.latest is None
    assert release_checker.checked_at == NOW


@pytest.mark.anyio
async def test_unexpected_error_is_a_logged_failed_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*_args: object) -> None:
        raise ZeroDivisionError

    monkeypatch.setattr("geometrikks.services.release_check.select_newer_release", explode)
    fake_github = FakeGithub(releases_response(etag='"one"'))
    release_checker = fake_github.checker()

    with structlog.testing.capture_logs() as logs:
        await release_checker.run()

    failed_logs = [log for log in logs if log["event"] == "release_check_failed"]
    assert [log["reason"] for log in failed_logs] == ["ZeroDivisionError"]
    assert isinstance(failed_logs[0]["exc_info"], ZeroDivisionError)
    assert release_checker.etag is None
    assert release_checker.checked_at is None


@pytest.mark.anyio
async def test_overlapping_runs_are_serialized() -> None:
    in_flight = 0
    peak_in_flight = 0
    requests: list[httpx2.Request] = []
    answers = [releases_response(etag='"one"'), httpx2.Response(304)]

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal in_flight, peak_in_flight
        in_flight += 1
        peak_in_flight = max(peak_in_flight, in_flight)
        requests.append(request)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return answers.pop(0)

    release_checker = ReleaseChecker(
        "0.22.0", transport=httpx2.MockTransport(handler), clock=lambda: NOW
    )

    await asyncio.gather(release_checker.run(), release_checker.run())

    assert peak_in_flight == 1
    assert "if-none-match" not in requests[0].headers
    assert requests[1].headers["if-none-match"] == '"one"'
    assert release_checker.etag == '"one"'


def test_release_check_enabled_is_off_with_the_scheduler_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from geometrikks.config.settings import AppSettings, SchedulerSettings, Settings
    from geometrikks.services.release_check import release_check_enabled

    monkeypatch.setattr("geometrikks.config.settings.get_installed_version", lambda: "0.22.0")
    app_settings = AppSettings(update_check=True, _env_file=None)
    enabled = Settings(scheduler=SchedulerSettings(enabled=True, _env_file=None), app=app_settings)
    disabled = Settings(scheduler=SchedulerSettings(enabled=False, _env_file=None), app=app_settings)

    assert release_check_enabled(enabled) is True
    assert release_check_enabled(disabled) is False
