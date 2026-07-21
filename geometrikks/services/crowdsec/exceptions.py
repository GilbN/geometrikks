"""Domain exceptions for the CrowdSec integration.

The service raises these instead of leaking httpx exceptions; app-level
handlers in server/core.py translate them to HTTP responses.
"""
from __future__ import annotations

class CrowdSecError(Exception):
    """Base for CrowdSec integration failures."""


class CrowdSecUnavailableError(CrowdSecError):
    """LAPI unreachable or returned an unexpected error response."""


class CrowdSecAuthError(CrowdSecError):
    """Bouncer key or machine credentials rejected, or missing configuration."""
