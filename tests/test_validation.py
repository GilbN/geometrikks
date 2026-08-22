"""Timezone validation for the chart ``tz`` query parameter."""
from __future__ import annotations

import pytest

from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.lib.validation import validate_timezone


def test_accepts_iana_name():
    assert validate_timezone("Europe/Oslo") == "Europe/Oslo"


def test_accepts_utc():
    assert validate_timezone("UTC") == "UTC"


def test_rejects_unknown_zone():
    with pytest.raises(DomainValidationError):
        validate_timezone("Mars/Olympus_Mons")


def test_rejects_path_like_values():
    with pytest.raises(DomainValidationError):
        validate_timezone("../etc/passwd")
