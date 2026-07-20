"""App-level exception handlers translating domain errors to HTTP responses."""
from __future__ import annotations

import logging

from litestar import MediaType, Request, Response
from litestar.status_codes import HTTP_500_INTERNAL_SERVER_ERROR, HTTP_502_BAD_GATEWAY

from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError

logger = logging.getLogger(__name__)


def handle_crowdsec_unavailable(
    request: Request, exc: CrowdSecUnavailableError
) -> Response:
    """502: the LAPI is down or misbehaving; never echo the upstream detail."""
    logger.warning("CrowdSec LAPI unavailable: %s", exc)
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_502_BAD_GATEWAY,
        content={"status_code": HTTP_502_BAD_GATEWAY, "detail": "CrowdSec LAPI is unreachable"},
    )


def handle_crowdsec_auth_error(request: Request, exc: CrowdSecAuthError) -> Response:
    """500: configured credentials were rejected; an operator must fix them."""
    logger.error("CrowdSec credentials rejected: %s", exc)
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "status_code": HTTP_500_INTERNAL_SERVER_ERROR,
            "detail": "CrowdSec credentials rejected; check CROWDSEC_* settings",
        },
    )


CROWDSEC_EXCEPTION_HANDLERS = {
    CrowdSecUnavailableError: handle_crowdsec_unavailable,
    CrowdSecAuthError: handle_crowdsec_auth_error,
}
