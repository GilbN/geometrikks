"""App-level exception handlers translating domain errors to HTTP responses."""
from __future__ import annotations

from litestar import MediaType, Request, Response
from litestar.exceptions import NotFoundException
from litestar.status_codes import (
    HTTP_400_BAD_REQUEST,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
    HTTP_500_INTERNAL_SERVER_ERROR,
    HTTP_502_BAD_GATEWAY,
)
from litestar.types import ExceptionHandlersMap

from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError, DomainValidationError
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import CrowdSecAuthError, CrowdSecUnavailableError

logger = get_logger(__name__)


def handle_domain_validation_error(request: Request, exc: DomainValidationError) -> Response:
    """400: a client-supplied value failed a domain invariant."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_400_BAD_REQUEST,
        content={"status_code": HTTP_400_BAD_REQUEST, "detail": exc.detail},
    )


def handle_domain_not_found(request: Request, exc: DomainNotFoundError) -> Response:
    """404: a domain lookup by name or id found nothing."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_404_NOT_FOUND,
        content={"status_code": HTTP_404_NOT_FOUND, "detail": exc.detail},
    )


def handle_domain_conflict(request: Request, exc: DomainConflictError) -> Response:
    """409: the request contradicts the resource's current state."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_409_CONFLICT,
        content={"status_code": HTTP_409_CONFLICT, "detail": exc.detail},
    )


def handle_not_found(request: Request, exc: NotFoundException) -> Response:
    """404: native JSON envelope for API paths, empty body elsewhere.

    litestar-vite only registers its own NotFoundException handler when none
    is present, so this one owns all 404 rendering. Non-API paths keep the
    plugin's empty-body behavior for static-asset misses; API paths get the
    same native envelope as every other error.

    The match is deliberately the whole /api/ namespace, not just /api/v1/:
    it mirrors the auth boundary (NON_API_PATTERN in server/auth.py), which
    reserves everything under /api/ for the REST API. A request to an unknown
    or unversioned /api/ path comes from an API consumer and gets JSON.
    """
    if request.scope["path"].startswith("/api/"):
        return Response(
            media_type=MediaType.JSON,
            status_code=HTTP_404_NOT_FOUND,
            content={"status_code": HTTP_404_NOT_FOUND, "detail": exc.detail},
        )
    return Response(status_code=HTTP_404_NOT_FOUND, content=b"")


def handle_crowdsec_unavailable(request: Request, exc: Exception) -> Response:
    """502: the LAPI is down or misbehaving; never echo the upstream detail."""
    logger.warning("CrowdSec LAPI unavailable: %s", exc)
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_502_BAD_GATEWAY,
        content={"status_code": HTTP_502_BAD_GATEWAY, "detail": "CrowdSec LAPI is unreachable"},
    )


def handle_crowdsec_auth_error(request: Request, exc: Exception) -> Response:
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


CROWDSEC_EXCEPTION_HANDLERS: ExceptionHandlersMap = {
    CrowdSecUnavailableError: handle_crowdsec_unavailable,
    CrowdSecAuthError: handle_crowdsec_auth_error,
}

# The complete domain-to-HTTP translation map registered by create_app().
EXCEPTION_HANDLERS: ExceptionHandlersMap = {
    **CROWDSEC_EXCEPTION_HANDLERS,
    DomainValidationError: handle_domain_validation_error,
    DomainNotFoundError: handle_domain_not_found,
    DomainConflictError: handle_domain_conflict,
    NotFoundException: handle_not_found,
}
