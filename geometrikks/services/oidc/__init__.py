"""OpenID Connect client: discovery, code exchange, ID token validation."""

from geometrikks.services.oidc.client import (
    OidcClient,
    OidcCompletion,
    OidcIdentity,
    PendingLogin,
    ProviderMetadata,
    build_identity,
    check_allow_list,
    create_oidc_http_client,
)
from geometrikks.services.oidc.errors import (
    OidcError,
    OidcForbidden,
    OidcProtocolError,
    OidcUnavailable,
)

__all__ = [
    "OidcClient",
    "OidcCompletion",
    "OidcError",
    "OidcForbidden",
    "OidcIdentity",
    "OidcProtocolError",
    "OidcUnavailable",
    "PendingLogin",
    "ProviderMetadata",
    "build_identity",
    "check_allow_list",
    "create_oidc_http_client",
]
