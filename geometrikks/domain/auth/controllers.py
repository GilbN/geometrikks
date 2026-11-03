"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

from typing import Annotated, Literal

import msgspec

from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotAuthorizedException, NotFoundException
from litestar.params import JSONBody, QueryParameter, SkipValidation
from litestar.response import Redirect
from litestar.status_codes import HTTP_200_OK

from geometrikks.config.settings import Settings
from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server import runtime
from geometrikks.server.api_key_auth import NO_CREDENTIALS_SECURITY, SESSION_ONLY_SECURITY, requires_session_user
from geometrikks.server.auth import AdminUser, AuthState, require_session_database, rotate_session
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger
from geometrikks.services.oidc import (
    OidcForbidden,
    OidcProtocolError,
    OidcUnavailable,
    PendingLogin,
)


login_logger = get_logger(LOGIN_LOGGER_NAME)


class LoginPayload(msgspec.Struct, rename="camel"):
    """The admin username and password."""

    username: str
    password: str


class SessionUser(msgspec.Struct, tag_field="mode", tag="session", rename="camel"):
    """The user of the current browser session."""

    username: str
    provider: Annotated[
        Literal["password", "oidc"],
        msgspec.Meta(description="How the user logged in, with the admin password or through OIDC single sign-on."),
    ]


class AuthDisabled(msgspec.Struct, tag_field="mode", tag="disabled", rename="camel"):
    """The server runs with APP_AUTH_DISABLED=true, so there is no session and no user."""


# A tagged union rather than one struct with a nullable username: it makes the
# generated TypeScript a discriminated union, so the UI cannot read username
# without first narrowing on mode.
MeResponse = SessionUser | AuthDisabled


class OidcOption(msgspec.Struct, rename="camel"):
    """The OIDC single sign-on login."""

    provider_name: Annotated[
        str, msgspec.Meta(description="The name in the Sign in with button, from OIDC_PROVIDER_NAME. Defaults to SSO.")
    ]


class AuthOptions(msgspec.Struct, rename="camel"):
    """The login methods this server offers."""

    password: Annotated[bool, msgspec.Meta(description="Whether the username and password login is on.")]
    oidc: OidcOption | None


class LogoutResponse(msgspec.Struct, rename="camel"):
    """Where the browser goes after logging out."""

    redirect_to: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The identity provider's sign-out URL. GeoMetrikks sets it when the session came from OIDC, "
                "OIDC_LOGOUT_IDP is on and the provider's discovery document lists an end_session_endpoint. "
                "Null means the login page."
            )
        ),
    ]


class OidcStatus(msgspec.Struct, rename="camel"):
    """The state of OIDC single sign-on, as Settings > Status shows it."""

    configured: bool
    provider_name: str | None
    issuer: str | None
    discovery: Annotated[
        Literal["ok", "failed", "pending"],
        msgspec.Meta(
            description=(
                "Whether reading the issuer's discovery document worked. `pending` means no attempt has "
                "finished yet, or OIDC is not configured."
            )
        ),
    ]
    detail: Annotated[
        str | None, msgspec.Meta(description="The error from the last failed discovery attempt, else null.")
    ]
    password_login: Annotated[bool, msgspec.Meta(description="Whether the username and password login is on.")]
    idp_logout: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "OIDC_LOGOUT_IDP. When true, logout also ends the identity provider session if the provider "
                "lists an end_session_endpoint."
            )
        ),
    ]


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

    @post(
        "/login",
        status_code=HTTP_200_OK,
        exclude_from_auth=True,
        security=NO_CREDENTIALS_SECURITY,
        summary="Log in with the admin username and password",
        description=(
            "Checks the admin username and password, starts a browser session and sets its cookie. "
            "Wrong credentials get a 401, and so does every attempt while password login is off because "
            "only OIDC is set up. A 503 means the database is down and nobody can log in. With "
            "APP_AUTH_DISABLED=true it checks nothing and answers with `mode` set to `disabled`."
        ),
    )
    async def login(
        self,
        request: Request,
        data: JSONBody[LoginPayload],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> MeResponse:
        if settings.auth_disabled:
            # Nothing to verify and no session to establish. Answering 200
            # keeps this off the exception path; the SPA redirects away from
            # /login before it can get here anyway.
            return AuthDisabled()
        require_session_database(request)
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

    @post(
        "/logout",
        status_code=HTTP_200_OK,
        guards=[requires_session_user],
        security=SESSION_ONLY_SECURITY,
        summary="Log out and end the browser session",
        description=(
            "Ends the current session. After an OIDC login with OIDC_LOGOUT_IDP on, `redirectTo` holds the "
            "identity provider's sign-out URL, as long as the provider lists an end_session_endpoint. "
            "API keys get a 403 here; use a browser session."
        ),
    )
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

    @get(
        "/me",
        guards=[requires_session_user],
        security=SESSION_ONLY_SECURITY,
        summary="Get the logged-in user",
        description=(
            "Returns the username and how the user logged in. A request without a session gets a 401. "
            "With APP_AUTH_DISABLED=true it answers with `mode` set to `disabled`. API keys get a 403 here; "
            "use a browser session."
        ),
    )
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

    @get(
        "/options",
        exclude_from_auth=True,
        security=NO_CREDENTIALS_SECURITY,
        summary="List the login methods this server offers",
        description=(
            "Says whether password login is on and, when OIDC single sign-on is set up, gives the provider's "
            "name. It needs no credentials, so the login page can call it first. With APP_AUTH_DISABLED=true "
            "both are off."
        ),
    )
    async def options(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> AuthOptions:
        if settings.auth_disabled:
            return AuthOptions(password=False, oidc=None)
        oidc = OidcOption(provider_name=settings.oidc.provider_name) if settings.oidc.enabled else None
        return AuthOptions(password=settings.password_login_enabled, oidc=oidc)

    @get(
        "/oidc/status",
        guards=[requires_session_user],
        security=SESSION_ONLY_SECURITY,
        summary="Get the OIDC single sign-on status",
        description=(
            "Reports whether OIDC is configured, whether discovery against the issuer worked and the last "
            "discovery error. It also says whether password login and identity provider logout are on. "
            "API keys get a 403 here; use a browser session."
        ),
    )
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

    @get("/oidc/start", exclude_from_auth=True, include_in_schema=False, security=NO_CREDENTIALS_SECURITY)
    async def oidc_start(self, request: Request) -> Redirect:
        """Browser navigation from the login button: send it to the provider."""
        client = runtime.get_oidc_client(request.app)
        if client is None:
            raise NotFoundException()
        require_session_database(request)
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

    @get("/oidc/callback", exclude_from_auth=True, include_in_schema=False, security=NO_CREDENTIALS_SECURITY)
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
        require_session_database(request)
        session = dict(request.session or {})
        pending = PendingLogin.from_session(session.pop("oidc_pending", None))
        # Consumed either way: a replayed callback must find nothing.
        request.set_session(session)
        if pending is None or not pending.matches_state(oidc_state):
            return self._oidc_failure(request, "oidc_failed", reason="state_mismatch")
        if pending.expired():
            return self._oidc_failure(request, "oidc_failed", reason="pending_expired")
        if error is not None:
            # Only the error code, never error_description, and truncated:
            # it comes straight off an unauthenticated query string.
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
