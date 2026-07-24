#!/bin/bash
set -euo pipefail

# Started with a non-root `user:` override (rootless docker, hardened
# setups): no privilege to remap anything, so behave exactly like the old
# static-USER image and run the command as-is.
if [ "$(id -u)" -ne 0 ]; then
    exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -g geometrikks)" -ne "$PGID" ]; then
    groupmod --non-unique --gid "$PGID" geometrikks
fi
if [ "$(id -u geometrikks)" -ne "$PUID" ]; then
    usermod --non-unique --uid "$PUID" geometrikks
fi

# Docker auto-creates a missing ./logs bind mount owned root:root, and the
# geoip named volume is initialized owned by the build-time uid 1000; both
# must be writable by the runtime uid. /app itself (non-recursive) must be
# writable too: litestar-vite rewrites /app/.litestar.json at startup via
# mkstemp + rename, which needs write on the directory.
chown "$PUID:$PGID" /app
chown -R "$PUID:$PGID" /app/logs /app/data/geoip

echo "geometrikks: starting as uid=$PUID gid=$PGID"
exec gosu geometrikks "$@"
