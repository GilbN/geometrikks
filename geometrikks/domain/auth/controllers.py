"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

from dataclasses import dataclass

import msgspec

from litestar import Controller, Request, get, post
from litestar.exceptions import NotAuthorizedException
from litestar.status_codes import HTTP_200_OK, HTTP_204_NO_CONTENT

from geometrikks.lib.client_ip import resolve_client_ip
from geometrikks.server.auth import AdminUser, AuthState
from geometrikks.server.logging import LOGIN_LOGGER_NAME, get_logger


logger = get_logger(__name__)
login_logger = get_logger(LOGIN_LOGGER_NAME)


@dataclass
class LoginPayload:
    username: str
    password: str


class MeResponse(msgspec.Struct, rename="camel"):
    username: str


class AuthController(Controller):
    """Session login/logout. /login is excluded from the auth middleware."""

    path = "/auth"
    tags = ["Auth"]

    @post("/login", status_code=HTTP_200_OK, exclude_from_auth=True)
    async def login(self, request: Request, data: LoginPayload) -> MeResponse:
        auth_state: AuthState = request.app.state.auth_state
        client_ip = resolve_client_ip(request)
        if not auth_state.verify(data.username, data.password):
            login_logger.warning("login_failed", user=data.username, ip=client_ip)
            raise NotAuthorizedException(detail="Invalid credentials")
        request.set_session({"username": data.username})
        login_logger.info("login_success", user=data.username, ip=client_ip)
        return MeResponse(username=data.username)

    @post("/logout", status_code=HTTP_204_NO_CONTENT)
    async def logout(self, request: Request) -> None:
        username = (request.session or {}).get("username", "")
        login_logger.info("logout", user=username, ip=resolve_client_ip(request))
        request.clear_session()

    @get("/me")
    async def me(self, request: Request) -> MeResponse:
        user: AdminUser = request.user
        return MeResponse(username=user.username)
