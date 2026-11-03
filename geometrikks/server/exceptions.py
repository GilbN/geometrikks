"""App-level exception handlers translating domain errors to HTTP responses."""
from __future__ import annotations

import msgspec
from litestar import MediaType, Request, Response
from litestar.exceptions import (
    HTTPException,
    NotAuthorizedException,
    NotFoundException,
    PermissionDeniedException,
    ServiceUnavailableException,
    ValidationException,
)
from litestar.exceptions.responses import create_debug_response, create_exception_response
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
from geometrikks.services.crowdsec import (
    CrowdSecAuthError,
    CrowdSecUnavailableError,
    CrowdSecUnsupportedError,
)
from geometrikks.services.rdap import RdapUnavailableError

logger = get_logger(__name__)


# Litestar's native envelope keeps snake_case keys (docs/api-conventions.md).
class ErrorEnvelope(msgspec.Struct):
    """The JSON body of an error response.

    Its keys are snake_case, unlike the camelCase keys of successful responses.
    """

    status_code: int
    detail: str
    code: str


class InvalidApiKeyError(NotAuthorizedException):
    code = "api_key_invalid"


class ExpiredApiKeyError(NotAuthorizedException):
    code = "api_key_expired"


class ReadOnlyApiKeyError(PermissionDeniedException):
    code = "api_key_read_only"


class SessionRequiredError(PermissionDeniedException):
    code = "session_required"


class ApiKeysUnavailableError(ServiceUnavailableException):
    code = "api_keys_unavailable"


_STATUS_CODES = {
    400: "invalid_request", 401: "not_authenticated", 403: "forbidden",
    404: "not_found", 405: "method_not_allowed", 409: "conflict",
    413: "request_too_large", 415: "unsupported_media_type", 429: "rate_limited",
    500: "internal_error", 502: "upstream_unavailable", 503: "unavailable",
}


def handle_http_exception(request: Request, exc: HTTPException) -> Response:
    """Add a code to API errors while preserving exception headers and extra."""
    if exc.status_code == 500 and request.app.debug:
        return create_debug_response(request, exc)
    if not request.scope["path"].startswith("/api/"):
        return create_exception_response(request, exc)
    code = getattr(exc, "code", None) or (
        "validation_failed" if isinstance(exc, ValidationException)
        else _STATUS_CODES.get(exc.status_code, "http_error")
    )
    content = {
        "status_code": exc.status_code,
        "detail": "Internal Server Error" if exc.status_code == 500 else exc.detail,
        "code": code,
    }
    if exc.extra is not None:
        content["extra"] = exc.extra
    return Response(content=content, status_code=exc.status_code, headers=exc.headers, media_type=MediaType.JSON)


def handle_domain_validation_error(request: Request, exc: DomainValidationError) -> Response:
    """400: a client-supplied value failed a domain invariant."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_400_BAD_REQUEST,
        content={"status_code": HTTP_400_BAD_REQUEST, "detail": exc.detail, "code": exc.code},
    )


def handle_domain_not_found(request: Request, exc: DomainNotFoundError) -> Response:
    """404: a domain lookup by name or id found nothing."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_404_NOT_FOUND,
        content={"status_code": HTTP_404_NOT_FOUND, "detail": exc.detail, "code": exc.code},
    )


def handle_domain_conflict(request: Request, exc: DomainConflictError) -> Response:
    """409: the request contradicts the resource's current state."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_409_CONFLICT,
        content={"status_code": HTTP_409_CONFLICT, "detail": exc.detail, "code": exc.code},
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
        return handle_http_exception(request, exc)
    return Response(status_code=HTTP_404_NOT_FOUND, content=b"")


def handle_crowdsec_unavailable(request: Request, exc: Exception) -> Response:
    """502: the LAPI is down or misbehaving; never echo the upstream detail."""
    logger.warning("CrowdSec LAPI unavailable: %s", exc)
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_502_BAD_GATEWAY,
        content={"status_code": HTTP_502_BAD_GATEWAY, "detail": "CrowdSec LAPI is unreachable", "code": "crowdsec_unreachable"},
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
            "code": "crowdsec_credentials_rejected",
        },
    )


def handle_crowdsec_unsupported(request: Request, exc: Exception) -> Response:
    """400: the request needs a newer LAPI than the one configured. The
    message is ours, not the LAPI's."""
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_400_BAD_REQUEST,
        content={"status_code": HTTP_400_BAD_REQUEST, "detail": str(exc), "code": "crowdsec_unsupported"},
    )


def handle_rdap_unavailable(request: Request, exc: Exception) -> Response:
    """502: IANA or the registry failed. The detail names the host and the
    status or error class, never the upstream body."""
    logger.warning("RDAP lookup failed: %s", exc)
    return Response(
        media_type=MediaType.JSON,
        status_code=HTTP_502_BAD_GATEWAY,
        content={"status_code": HTTP_502_BAD_GATEWAY, "detail": f"RDAP lookup failed ({exc})", "code": "rdap_unavailable"},
    )


CROWDSEC_EXCEPTION_HANDLERS: ExceptionHandlersMap = {
    CrowdSecUnavailableError: handle_crowdsec_unavailable,
    CrowdSecAuthError: handle_crowdsec_auth_error,
    CrowdSecUnsupportedError: handle_crowdsec_unsupported,
}

# The complete domain-to-HTTP translation map registered by create_app().
EXCEPTION_HANDLERS: ExceptionHandlersMap = {
    HTTPException: handle_http_exception,
    **CROWDSEC_EXCEPTION_HANDLERS,
    RdapUnavailableError: handle_rdap_unavailable,
    DomainValidationError: handle_domain_validation_error,
    DomainNotFoundError: handle_domain_not_found,
    DomainConflictError: handle_domain_conflict,
    NotFoundException: handle_not_found,
}
