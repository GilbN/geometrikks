"""Failure classes the auth endpoints translate into fixed login-page codes."""

from __future__ import annotations


class OidcError(Exception):
    """Base class for every OIDC failure."""


class OidcUnavailable(OidcError):
    """The identity provider could not be reached or answered nonsense."""


class OidcProtocolError(OidcError):
    """State, token, or claim validation failed. ``reason`` is the login-log value."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


class OidcForbidden(OidcError):
    """Authenticated at the identity provider but not on the allow list."""

    def __init__(self, subject: str, email: str | None, groups: tuple[str, ...]) -> None:
        super().__init__(f"{subject} is not on the allow list")
        self.subject = subject
        self.email = email
        self.groups = groups
