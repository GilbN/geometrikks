"""AbuseIPDB report submission: reporter mapping, IP checks and the refusals before the database."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx2
import pytest

from geometrikks.domain.abuseipdb.errors import ReportingDisabledError
from geometrikks.domain.abuseipdb.service import (
    Reporter,
    ReportSubmission,
    normalize_public_ip,
    reporter_from_user,
    submit_report,
)
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.server.api_key_auth import ApiKeyPrincipal
from geometrikks.server.auth import AdminUser
from geometrikks.services.abuseipdb import AbuseIpdbClient

pytestmark = pytest.mark.anyio

KEY_ID = UUID("0b6f1c2e-6a39-4f3e-9d5a-2f8f2b1c7e10")
NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
REPORTER = Reporter("user", "gilbn", None)


class ReachedRepositoryError(Exception):
    """Raised when submit_report gets past the checks that need no database."""


class UntouchableRepository:
    def __getattr__(self, name: str):
        raise ReachedRepositoryError(name)


def refusing_client() -> AbuseIpdbClient:
    def handler(request: httpx2.Request) -> httpx2.Response:
        pytest.fail("submit_report called AbuseIPDB before its checks passed")

    return AbuseIpdbClient(api_key="test-key", timeout=5, transport=httpx2.MockTransport(handler))


def submission(**overrides) -> ReportSubmission:
    fields = {
        "ip_address": "3.5.140.2",
        "categories": [18, 22],
        "comment": "ssh brute force",
        "attack_time": NOW - timedelta(minutes=5),
    }
    fields.update(overrides)
    return ReportSubmission(**fields)


async def submit(report: ReportSubmission):
    return await submit_report(
        report,
        reporter=REPORTER,
        repository=UntouchableRepository(),  # ty: ignore[invalid-argument-type]
        client=refusing_client(),
        reporting_enabled=True,
        now=NOW,
    )


@pytest.mark.parametrize(
    ("user", "expected"),
    [
        (AdminUser(username="gilbn"), Reporter("user", "gilbn", None)),
        (
            ApiKeyPrincipal(key_id=KEY_ID, name="homepage", scope="read_write", expires_at=None),
            Reporter("api_key", "homepage", KEY_ID),
        ),
        (None, Reporter("anonymous", None, None)),
    ],
)
def test_reporter_from_user(user, expected):
    assert reporter_from_user(user) == expected


@pytest.mark.parametrize(
    "value",
    [
        "10.0.0.1", "127.0.0.2", "::1", "203.0.113.7", "2001:db8::1", "fe80::1%eth0", "not-an-ip",
        "2600:1f18::1%eth0", "::ffff:10.0.0.1",
    ],
)
def test_non_public_or_invalid_ips_are_refused(value):
    with pytest.raises(DomainValidationError) as refusal:
        normalize_public_ip(value)

    assert refusal.value.code == "invalid_ip"


def test_ipv6_is_normalized():
    assert normalize_public_ip(" 2600:1F18:0:0::1 ") == "2600:1f18::1"


def test_ipv4_mapped_ipv6_becomes_the_ipv4_address():
    assert normalize_public_ip("::ffff:8.8.8.8") == "8.8.8.8"


@pytest.mark.parametrize(("reporting_enabled", "with_client"), [(False, True), (True, False)])
async def test_disabled_reporting_is_refused_first(reporting_enabled, with_client):
    client = refusing_client() if with_client else None

    with pytest.raises(ReportingDisabledError) as refusal:
        await submit_report(
            submission(ip_address="10.0.0.1", categories=[]),
            reporter=REPORTER,
            repository=UntouchableRepository(),  # ty: ignore[invalid-argument-type]
            client=client,
            reporting_enabled=reporting_enabled,
            now=NOW,
        )

    assert refusal.value.status_code == 403
    assert refusal.value.code == "abuseipdb_reporting_disabled"
    assert refusal.value.detail == "Reporting requires ABUSEIPDB_REPORTING_ENABLED=true and ABUSEIPDB_API_KEY"


async def test_a_private_ip_is_refused_before_the_repository():
    with pytest.raises(DomainValidationError) as refusal:
        await submit(submission(ip_address="192.168.1.10"))

    assert refusal.value.code == "invalid_ip"


@pytest.mark.parametrize("categories", [[], [0], [24], [21, 21]])
async def test_categories_must_be_known_unique_and_present(categories):
    with pytest.raises(DomainValidationError, match="categories"):
        await submit(submission(categories=categories))


async def test_comment_limits_count_code_points():
    with pytest.raises(ReachedRepositoryError):
        await submit(submission(comment="😀" + "a" * 1023))
    with pytest.raises(ReachedRepositoryError):
        await submit(submission(comment="  " + "a" * 1024 + "\n"))

    for comment in ["a" * 1025, "   ", ""]:
        with pytest.raises(DomainValidationError, match="comment"):
            await submit(submission(comment=comment))


async def test_a_comment_with_a_nul_character_is_refused():
    with pytest.raises(DomainValidationError, match="comment"):
        await submit(submission(comment="ssh brute\x00force"))


@pytest.mark.parametrize(
    "attack_time",
    [datetime(2026, 11, 7, 11, 0), NOW + timedelta(seconds=1)],
    ids=["naive", "future"],
)
async def test_attack_time_must_be_aware_and_not_in_the_future(attack_time):
    with pytest.raises(DomainValidationError, match="attackTime"):
        await submit(submission(attack_time=attack_time))


async def test_attack_time_equal_to_now_passes_the_checks():
    with pytest.raises(ReachedRepositoryError):
        await submit(submission(attack_time=NOW))
