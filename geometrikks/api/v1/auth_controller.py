"""Login / logout / me endpoints for the single-admin session auth."""

from __future__ import annotations

from dataclasses import dataclass

from litestar import Controller, Request, get, post
from litestar.exceptions import NotAuthorizedException
from litestar.status_codes import HTTP_200_OK, HTTP_204_NO_CONTENT

from geometrikks.server.auth import AdminUser, AuthState


@dataclass
class LoginPayload:
    username: str
    password: str


@dataclass
class MeResponse:
    username: str


class AuthController(Controller):
    """Session login/logout. /login is excluded from the auth middleware."""

    path = "/api/v1/auth"
    tags = ["Auth"]

    @post("/login", status_code=HTTP_200_OK, exclude_from_auth=True)
    async def login(self, request: Request, data: LoginPayload) -> MeResponse:
        auth_state: AuthState = request.app.state.auth_state
        if not auth_state.verify(data.username, data.password):
            raise NotAuthorizedException(detail="Invalid credentials")
        request.set_session({"username": data.username})
        return MeResponse(username=data.username)

    @post("/logout", status_code=HTTP_204_NO_CONTENT)
    async def logout(self, request: Request) -> None:
        request.clear_session()

    @get("/me")
    async def me(self, request: Request) -> MeResponse:
        user: AdminUser = request.user
        return MeResponse(username=user.username)
