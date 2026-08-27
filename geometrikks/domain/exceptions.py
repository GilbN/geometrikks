"""Project-local domain exceptions.

Services and shared validation helpers raise these instead of Litestar HTTP
exceptions, so domain code carries no HTTP coupling. The translation to
status codes happens centrally in geometrikks/server/exceptions.py.
"""

from __future__ import annotations


class GeometrikksError(Exception):
    """Base class for all domain errors."""


class DomainValidationError(GeometrikksError):
    """A client-supplied value failed a domain invariant (translates to 400)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class DomainNotFoundError(GeometrikksError):
    """The named resource does not exist (translates to 404)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class DomainConflictError(GeometrikksError):
    """The request contradicts the resource's current state (translates to 409)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail
