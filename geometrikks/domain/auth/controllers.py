"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

import msgspec

from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotAuthorizedException
from litestar.params import SkipValidation
from litestar.status_codes import HTTP_200_OK, HTTP_204_NO_CONTENT

from geometrikks.config.settings import Settings
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server.auth import AdminUser, AuthState
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger


logger = get_logger(__name__)
login_logger = get_logger(LOGIN_LOGGER_NAME)


class LoginPayload(msgspec.Struct, rename="camel"):
    username: str
    password: str


class SessionUser(msgspec.Struct, tag_field="mode", tag="session", rename="camel"):
    """Someone is logged in through the built-in session auth."""

    username: str


class AuthDisabled(msgspec.Struct, tag_field="mode", tag="disabled", rename="camel"):
    """APP_AUTH_DISABLED=true: there is no session and no user to describe."""


# A tagged union rather than one struct with a nullable username: it makes the
# generated TypeScript a discriminated union, so the UI cannot read username
# without first narrowing on mode.
MeResponse = SessionUser | AuthDisabled


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
        auth_state: AuthState = request.app.state.auth_state
        client_ip = resolve_client_ip(request)
        if not auth_state.verify(data.username, data.password):
            login_logger.warning("login_failed", user=data.username, ip=client_ip)
            raise NotAuthorizedException(detail="Invalid credentials")
        request.set_session({"username": data.username})
        login_logger.info("login_success", user=data.username, ip=client_ip)
        return SessionUser(username=data.username)

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
        return SessionUser(username=user.username)
