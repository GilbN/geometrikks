# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Stage 1: Build frontend assets
# ------------------------------------------------------------------------------
# --platform=$BUILDPLATFORM: the vite/tsc output is architecture-independent,
# so always build it natively instead of under QEMU emulation (bun is slow and
# flaky when emulated during multi-arch release builds).
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS frontend-builder

WORKDIR /app

COPY package.json bun.lock ./

# Install dependencies (cached)
RUN --mount=type=cache,target=/root/.bun \
    bun install --frozen-lockfile

COPY resources/ ./resources/
COPY vite.config.ts tsconfig.json components.json ./
COPY index.html ./

RUN bun run build

# ------------------------------------------------------------------------------
# Stage 2: Python dependencies with uv
# ------------------------------------------------------------------------------
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS python-builder

WORKDIR /app

# Enable bytecode compilation and set link mode for faster installs
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock* README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Install the application as a built wheel, not an editable checkout: the
# runtime image then only needs the venv, and site-packages carries the
# package with proper dist-info instead of a path reference to /app source.
COPY geometrikks/ ./geometrikks/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv build --wheel \
    && uv pip install --no-deps dist/*.whl

# ------------------------------------------------------------------------------
# Stage 3: Production runtime
# ------------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS production

ARG APP_IMAGE_TAG=local

RUN groupadd --gid 1000 geometrikks \
    && useradd --uid 1000 --gid geometrikks --shell /bin/bash --create-home geometrikks

# gosu: the entrypoint starts as root to remap the geometrikks user to
# PUID/PGID and fix volume ownership, then drops privileges with it.
# tini: PID 1 init that forwards signals to the exec'd server process and
# reaps any orphaned children the app itself would not wait on.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The venv carries the application as an installed wheel (see the builder
# stage), so no source tree is copied. Migrations, alembic.ini and the
# changelog stay outside the package and resolve relative to /app at runtime.
COPY --chown=geometrikks:geometrikks --from=python-builder /app/.venv /app/.venv
COPY --chown=geometrikks:geometrikks --from=frontend-builder /app/public /app/public
COPY --chown=geometrikks:geometrikks --from=frontend-builder /app/index.html /app/public/index.html
COPY --chown=geometrikks:geometrikks alembic.ini CHANGELOG.md ./
COPY --chown=geometrikks:geometrikks migrations/ ./migrations/

RUN mkdir -p /app/logs /app/data/geoip \
    && chown -R geometrikks:geometrikks /app

# Set environment
# GEOIP_VALIDATE_DB_PATH=false: settings construction must not fail while the
# geoip volume is empty; the downloader/degraded-mode path owns that now.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_ENVIRONMENT=production \
    APP_RUNTIME=container \
    APP_IMAGE_TAG=${APP_IMAGE_TAG} \
    VITE_DEV_MODE=false \
    GEOIP_DB_PATH=/app/data/geoip/GeoLite2-City.mmdb \
    GEOIP_ASN_DB_PATH=/app/data/geoip/GeoLite2-ASN.mmdb \
    GEOIP_VALIDATE_DB_PATH=false \
    LITESTAR_APP=geometrikks.server.core:create_app

VOLUME ["/app/data/geoip"]

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Granian registers handlers for both SIGTERM and SIGINT; with
# --no-subprocess below the signal reaches the Granian master directly
# through the tini -> entrypoint -> gosu exec chain, so SIGTERM produces a
# graceful shutdown (ingestion drains, scheduler stops, workers exit).
STOPSIGNAL SIGTERM
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()" || exit 1

# tini is PID 1; the entrypoint remaps the geometrikks user to PUID/PGID
# (default 1000:1000), chowns /app/logs and /app/data/geoip, and drops
# privileges before exec-ing the CMD. With a non-root `user:` override it
# just execs.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Run with Granian via the Litestar CLI.
# --no-subprocess: run the Granian master in this process instead of a
#   child; the default subprocess mode has no SIGTERM forwarding, so
#   `docker stop` would kill the CLI wrapper and take Granian down with the
#   PID namespace, skipping lifespan teardown entirely.
# --workers 1: explicit single worker. Sessions, WebSocket fan-out, the
#   scheduler, ingestion, and startup migrations are all process-local;
#   see docs/deployment.md before raising this.
# --workers-kill-timeout 15: litestar-granian's default is 5s, which races
#   ingestion's own 5s stop window exactly; 15s lets a slow teardown
#   (ingestion drain + scheduler + CrowdSec client) finish before the
#   worker is force-killed. Pair with `docker stop -t 20` or a compose
#   stop_grace_period of at least 20s.
CMD ["litestar", "--app", "geometrikks.server.core:create_app", "run", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-subprocess", "--workers-kill-timeout", "15"]
