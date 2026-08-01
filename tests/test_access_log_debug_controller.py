"""Custom providers/validators for the access-log-debug endpoints.

Pagination and search are provided declaratively by advanced-alchemy's
``create_service_dependencies`` (library-tested); these tests cover the
project-specific time-window provider and IP validation.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from advanced_alchemy.filters import OnBeforeAfter
from geometrikks.domain.exceptions import DomainValidationError

from geometrikks.api.v1.access_log_debug_controller import (
    provide_debug_time_window,
    validated_ips,
)


class TestTimeWindow:
    def test_no_window_when_both_bounds_none(self) -> None:
        assert provide_debug_time_window(None, None) == []

    def test_adds_inclusive_window_on_created_at(self) -> None:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        end = datetime(2026, 7, 2, tzinfo=timezone.utc)
        result = provide_debug_time_window(start, end)
        assert len(result) == 1
        window = result[0]
        assert isinstance(window, OnBeforeAfter)
        assert window.field_name == "created_at"
        assert window.on_or_after == start
        assert window.on_or_before == end


class TestValidatedIps:
    def test_absent_or_empty_yields_none(self) -> None:
        assert validated_ips(None) is None
        assert validated_ips([]) is None

    def test_valid_ips_pass_through(self) -> None:
        assert validated_ips(["10.0.0.1", "2001:db8::1"]) == ["10.0.0.1", "2001:db8::1"]

    def test_invalid_ip_raises_validation_error(self) -> None:
        # ip_address is INET on the joined table; free text must 400.
        with pytest.raises(DomainValidationError, match="Invalid IP address"):
            validated_ips(["not-an-ip"])
