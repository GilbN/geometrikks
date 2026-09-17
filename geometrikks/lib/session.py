"""Session-lifetime constants shared by the OIDC client and the session backend.

Standard library only: geometrikks/server/auth.py imports this, and importing
the OIDC client module instead would pull httpx2, jwt and cryptography into
every process.
"""

from __future__ import annotations

PENDING_LIFETIME_SECONDS = 10 * 60
