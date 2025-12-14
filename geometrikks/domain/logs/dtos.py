"""DTOs for geo-location and geo-event data transfer."""
from __future__ import annotations

from advanced_alchemy.extensions.litestar import SQLAlchemyDTO, SQLAlchemyDTOConfig

from geometrikks.domain.logs.models import AccessLog, AccessLogDebug

class AccessLogDTO(SQLAlchemyDTO[AccessLog]):
    """Data transfer object for AccessLog model."""
    config = SQLAlchemyDTOConfig(rename_strategy="camel")

class AccessLogDebugDTO(SQLAlchemyDTO[AccessLogDebug]):
    """Data transfer object for AccessLogDebug model."""
    config = SQLAlchemyDTOConfig(rename_strategy="camel")