"""Session-lifetime constants shared by the OIDC client and the session backend.

Import-time safe: standard library only. Kept dependency-free so the session
backend (geometrikks/server/auth.py) does not have to import the OIDC client
module, which pulls in httpx2, jwt and cryptography, just for this constant.
"""

from __future__ import annotations

PENDING_LIFETIME_SECONDS = 10 * 60
