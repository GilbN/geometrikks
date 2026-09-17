"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

from typing import Annotated, Literal

import msgspec

from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotAuthorizedException, NotFoundException
from litestar.params import QueryParameter, SkipValidation
from litestar.response import Redirect
from litestar.status_codes import HTTP_200_OK

from geometrikks.config.settings import Settings
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server import runtime
from geometrikks.server.auth import AdminUser, AuthState, rotate_session
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger
from geometrikks.services.oidc import (
    OidcForbidden,
    OidcProtocolError,
    OidcUnavailable,
    PendingLogin,
)


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


class LogoutResponse(msgspec.Struct, rename="camel"):
    """Where the browser should go next; null means the login page."""

    redirect_to: str | None


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

    @post("/logout", status_code=HTTP_200_OK)
    async def logout(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> LogoutResponse:
        if settings.auth_disabled:
            # request.session would raise without the session middleware.
            return LogoutResponse(redirect_to=None)
        session = request.session or {}
        username = session.get("username", "")
        provider = session.get("provider", "password")
        id_token = session.get("id_token")
        redirect_to: str | None = None
        if provider == "oidc" and settings.oidc.logout_idp and isinstance(id_token, str):
            client = runtime.get_oidc_client(request.app)
            if client is not None:
                redirect_to = client.end_session_url(id_token, settings.oidc.signed_out_url)
        login_logger.info(
            "logout",
            user=username,
            provider=provider,
            idp_logout=redirect_to is not None,
            ip=resolve_client_ip(request),
        )
        request.clear_session()
        return LogoutResponse(redirect_to=redirect_to)

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

    @get("/oidc/start", exclude_from_auth=True, include_in_schema=False)
    async def oidc_start(self, request: Request) -> Redirect:
        """Browser navigation from the login button: send it to the provider."""
        client = runtime.get_oidc_client(request.app)
        if client is None:
            raise NotFoundException()
        try:
            url, pending = await client.begin()
        except OidcUnavailable as exc:
            return self._oidc_failure(
                request, "oidc_unavailable", reason="discovery", error=type(exc).__name__
            )
        session = dict(request.session or {})
        session["oidc_pending"] = pending.to_session()
        request.set_session(session)
        return Redirect(url, headers={"Cache-Control": "no-store"})

    @get("/oidc/callback", exclude_from_auth=True, include_in_schema=False)
    async def oidc_callback(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
        code: Annotated[str | None, QueryParameter(required=False)] = None,
        # "state" is a reserved kwarg name in Litestar (ASGI app state), so the
        # query parameter is aliased to a differently named local parameter.
        oidc_state: Annotated[str | None, QueryParameter(name="state", required=False)] = None,
        error: Annotated[str | None, QueryParameter(required=False)] = None,
    ) -> Redirect:
        """The provider sends the browser back here with a one-time code."""
        client = runtime.get_oidc_client(request.app)
        if client is None:
            raise NotFoundException()
        session = dict(request.session or {})
        pending = PendingLogin.from_session(session.pop("oidc_pending", None))
        # Consumed either way: a replayed callback must find nothing.
        request.set_session(session)
        if pending is None or not pending.matches_state(oidc_state):
            return self._oidc_failure(request, "oidc_failed", reason="state_mismatch")
        if pending.expired():
            return self._oidc_failure(request, "oidc_failed", reason="pending_expired")
        if error is not None:
            # Only the standard error code, never error_description; truncated
            # since it comes verbatim off the query string of a request
            # nobody has authenticated yet.
            return self._oidc_failure(
                request, "oidc_denied", reason="idp_error", error=error[:64]
            )
        if not code:
            return self._oidc_failure(request, "oidc_failed", reason="missing_code")
        try:
            completion = await client.complete(code, pending)
        except OidcForbidden as exc:
            return self._oidc_failure(
                request,
                "oidc_forbidden",
                reason="not_allowed",
                subject=exc.subject,
                email=exc.email,
                groups=list(exc.groups),
            )
        except OidcProtocolError as exc:
            return self._oidc_failure(request, "oidc_failed", reason=exc.reason, detail=exc.detail)
        except OidcUnavailable as exc:
            return self._oidc_failure(
                request,
                "oidc_unavailable",
                reason="discovery",
                error=type(exc).__name__,
                detail=str(exc),
            )
        identity = completion.identity
        rotate_session(request)
        data: dict[str, object] = {"username": identity.username, "provider": "oidc"}
        if settings.oidc.logout_idp:
            data["id_token"] = completion.id_token
        request.set_session(data)
        login_logger.info(
            "login_success",
            provider="oidc",
            user=identity.username,
            subject=identity.subject,
            ip=resolve_client_ip(request),
        )
        return Redirect("/", headers={"Cache-Control": "no-store"})

    @staticmethod
    def _oidc_failure(request: Request, code: str, **fields: object) -> Redirect:
        """Log the real reason, send the browser back with only a fixed code."""
        login_logger.warning(
            "login_failed", provider="oidc", ip=resolve_client_ip(request), **fields
        )
        return Redirect(f"/login?error={code}", headers={"Cache-Control": "no-store"})
