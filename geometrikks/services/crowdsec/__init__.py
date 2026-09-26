"""CrowdSec Local API integration."""

from geometrikks.services.crowdsec.exceptions import (
    CrowdSecAuthError,
    CrowdSecError,
    CrowdSecUnavailableError,
    CrowdSecUnsupportedError,
)
from geometrikks.services.crowdsec.schemas import Alert, AlertContext, AlertEvent, Decision
from geometrikks.services.crowdsec.service import CrowdSecService, DecisionScope, DecisionType, manual_reason

__all__ = [
    "Alert",
    "AlertContext",
    "AlertEvent",
    "CrowdSecAuthError",
    "CrowdSecError",
    "CrowdSecService",
    "CrowdSecUnavailableError",
    "CrowdSecUnsupportedError",
    "Decision",
    "DecisionScope",
    "DecisionType",
    "manual_reason",
]
