# Security Policy

## Deployment model

GeoMetrikks is designed for LAN/VPN (homelab) deployment. The built-in
authentication is a single admin account with a session cookie — adequate
for a trusted network, not hardened for direct internet exposure.

Exposing it to the WAN? Put an authenticating reverse proxy (Authelia,
Authentik, Tailscale, ...) in front and set `APP_AUTH_DISABLED=true`, or at
minimum keep the built-in auth AND TLS-terminate in front of it (the app
serves plain HTTP).

Notes:
- Sessions are in-memory: an app restart logs everyone out.
- `/health` and `/health/ready` are unauthenticated by design (probes).
- Debug endpoints only exist when `APP_DEBUG=true` — don't run debug in production.
- The MaxMind license key is only ever sent to download.maxmind.com over HTTPS.

## Reporting a vulnerability

Report privately via GitHub: **Security → Advisories → Report a vulnerability**.
Please do not open public issues for exploitable problems. Best-effort response;
this is a hobby project.
