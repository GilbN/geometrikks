"""CrowdSec Local API integration."""

from geometrikks.services.crowdsec.exceptions import (
    CrowdSecAuthError,
    CrowdSecError,
    CrowdSecUnavailableError,
)
from geometrikks.services.crowdsec.schemas import Decision
from geometrikks.services.crowdsec.service import CrowdSecService

__all__ = [
    "CrowdSecAuthError",
    "CrowdSecError",
    "CrowdSecService",
    "CrowdSecUnavailableError",
    "Decision",
]
