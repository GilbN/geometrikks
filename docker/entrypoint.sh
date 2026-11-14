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

# PUID/PGID only take effect at the gosu exec below; everything up to it
# runs as root, so the chowns here are root's.
# Docker auto-creates a missing ./logs bind mount owned root:root, and the
# geoip named volume is initialized owned by the build-time uid 1000; both
# must be writable by the runtime uid. /app itself (non-recursive) must be
# writable too: litestar-vite rewrites /app/.litestar.json at startup via
# mkstemp + rename, which needs write on the directory.
chown "$PUID:$PGID" /app

# Only chown what has the wrong owner. A tree that is already right needs
# no write, so a read-only mount of user-supplied mmdb files (kept fresh by
# an external geoipupdate, say) starts cleanly. A mount that can't be fixed
# is a warning, not a crash loop: the app starts and reports what it can't
# write (file logging off, GeoLite2 downloads failing).
fix_ownership() {
    local path
    for path in "$@"; do
        if ! find "$path" \( ! -user "$PUID" -o ! -group "$PGID" \) \
            -exec chown -h "$PUID:$PGID" {} + 2>/dev/null; then
            echo "geometrikks: warning: could not chown everything in $path to $PUID:$PGID" \
                "(read-only mount?); starting anyway" >&2
        fi
    done
}
fix_ownership /app/logs /app/data/geoip

echo "geometrikks: starting as uid=$PUID gid=$PGID"
exec gosu geometrikks "$@"
