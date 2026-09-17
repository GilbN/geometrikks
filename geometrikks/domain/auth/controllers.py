"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

from typing import Literal

import msgspec

from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotAuthorizedException
from litestar.params import SkipValidation
from litestar.status_codes import HTTP_200_OK, HTTP_204_NO_CONTENT

from geometrikks.config.settings import Settings
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server import runtime
from geometrikks.server.auth import AdminUser, AuthState, rotate_session
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger


login_logger = get_logger(LOGIN_LOGGER_NAME)


class LoginPayload(msgspec.Struct, rename="camel"):
    username: str
    password: str


class SessionUser(msgspec.Struct, tag_field="mode", tag="session", rename="camel"):
    """Someone is logged in through the built-in session auth."""

    username: str
    provider: Literal["password", "oidc"]


class AuthDisabled(msgspec.Struct, tag_field="mode", tag="disabled", rename="camel"):
    """APP_AUTH_DISABLED=true: there is no session and no user to describe."""


# A tagged union rather than one struct with a nullable username: it makes the
# generated TypeScript a discriminated union, so the UI cannot read username
# without first narrowing on mode.
MeResponse = SessionUser | AuthDisabled


class OidcOption(msgspec.Struct, rename="camel"):
    provider_name: str


class AuthOptions(msgspec.Struct, rename="camel"):
    """Which login methods exist, readable before anyone is logged in."""

    password: bool
    oidc: OidcOption | None


class OidcStatus(msgspec.Struct, rename="camel"):
    """Discovery outcome for Settings > Status."""

    configured: bool
    provider_name: str | None
    issuer: str | None
    discovery: Literal["ok", "failed", "pending"]
    detail: str | None
    password_login: bool
    idp_logout: bool


class AuthController(Controller):
    """Session login/logout. /login is excluded from the auth middleware.

    Registered in every mode, including APP_AUTH_DISABLED=true. In that mode
    there is no session middleware and no app.state.auth_state, so every
    handler must answer from settings alone before touching request.user,
    request.session, or auth_state. Leaving the routes unregistered instead
    made the SPA's /auth/me call raise NotFoundException on every page load,
    logging an error-level traceback each time.
    """

    path = "/auth"
    tags = ["Auth"]

    @post("/login", status_code=HTTP_200_OK, exclude_from_auth=True)
    async def login(
        self,
        request: Request,
        data: LoginPayload,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> MeResponse:
        if settings.auth_disabled:
            # Nothing to verify and no session to establish. Answering 200
            # keeps this off the exception path; the SPA redirects away from
            # /login before it can get here anyway.
            return AuthDisabled()
        auth_state: AuthState | None = request.app.state.auth_state
        client_ip = resolve_client_ip(request)
        if auth_state is None:
            login_logger.warning(
                "login_failed",
                provider="password",
                reason="password_login_disabled",
                user=data.username,
                ip=client_ip,
            )
            raise NotAuthorizedException(detail="Password login is not enabled")
        if not auth_state.verify(data.username, data.password):
            login_logger.warning("login_failed", provider="password", user=data.username, ip=client_ip)
            raise NotAuthorizedException(detail="Invalid credentials")
        rotate_session(request)
        request.set_session({"username": data.username, "provider": "password"})
        login_logger.info("login_success", provider="password", user=data.username, ip=client_ip)
        return SessionUser(username=data.username, provider="password")

    @post("/logout", status_code=HTTP_204_NO_CONTENT)
    async def logout(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> None:
        if settings.auth_disabled:
            # request.session would raise without the session middleware.
            return
        username = (request.session or {}).get("username", "")
        login_logger.info("logout", user=username, ip=resolve_client_ip(request))
        request.clear_session()

    @get("/me")
    async def me(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> MeResponse:
        if settings.auth_disabled:
            return AuthDisabled()
        # Not excluded from auth: with auth enabled an anonymous caller must
        # still get 401 so the axios interceptor redirects to /login.
        user: AdminUser = request.user
        return SessionUser(username=user.username, provider=user.provider)

    @get("/options", exclude_from_auth=True)
    async def options(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> AuthOptions:
        if settings.auth_disabled:
            return AuthOptions(password=False, oidc=None)
        oidc = OidcOption(provider_name=settings.oidc.provider_name) if settings.oidc.enabled else None
        return AuthOptions(password=settings.password_login_enabled, oidc=oidc)

    @get("/oidc/status")
    async def oidc_status(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> OidcStatus:
        client = runtime.get_oidc_client(request.app)
        password_login = settings.password_login_enabled and not settings.auth_disabled
        if client is None:
            return OidcStatus(
                configured=False,
                provider_name=None,
                issuer=None,
                discovery="pending",
                detail=None,
                password_login=password_login,
                idp_logout=False,
            )
        if client.metadata_cached is not None:
            discovery: Literal["ok", "failed", "pending"] = "ok"
        elif client.last_error is not None:
            discovery = "failed"
        else:
            discovery = "pending"
        return OidcStatus(
            configured=True,
            provider_name=settings.oidc.provider_name,
            issuer=settings.oidc.issuer,
            discovery=discovery,
            detail=client.last_error,
            password_login=password_login,
            idp_logout=settings.oidc.logout_idp,
        )
