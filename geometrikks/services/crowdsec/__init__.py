"""CrowdSec Local API integration."""

from geometrikks.services.crowdsec.exceptions import (
    CrowdSecAuthError,
    CrowdSecError,
    CrowdSecUnavailableError,
)
from geometrikks.services.crowdsec.schemas import Alert, AlertContext, AlertEvent, Decision
from geometrikks.services.crowdsec.service import CrowdSecService

__all__ = [
    "Alert",
    "AlertContext",
    "AlertEvent",
    "CrowdSecAuthError",
    "CrowdSecError",
    "CrowdSecService",
    "CrowdSecUnavailableError",
    "Decision",
]
