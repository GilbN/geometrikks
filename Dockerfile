# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Stage 1: Build frontend assets
# ------------------------------------------------------------------------------
# --platform=$BUILDPLATFORM: the vite/tsc output is architecture-independent,
# so always build it natively instead of under QEMU emulation (bun is slow and
# flaky when emulated during multi-arch release builds).
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-slim@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0 AS frontend-builder

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

COPY geometrikks/ ./geometrikks/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ------------------------------------------------------------------------------
# Stage 3: Production runtime
# ------------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS production

ARG APP_IMAGE_TAG=local

RUN groupadd --gid 1000 geometrikks \
    && useradd --uid 1000 --gid geometrikks --shell /bin/bash --create-home geometrikks

# gosu: the entrypoint starts as root to remap the geometrikks user to
# PUID/PGID and fix volume ownership, then drops privileges with it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=geometrikks:geometrikks --from=python-builder /app/.venv /app/.venv
COPY --chown=geometrikks:geometrikks --from=python-builder /app/geometrikks /app/geometrikks
COPY --chown=geometrikks:geometrikks --from=frontend-builder /app/public /app/public
COPY --chown=geometrikks:geometrikks --from=frontend-builder /app/index.html /app/public/index.html
COPY --chown=geometrikks:geometrikks pyproject.toml alembic.ini ./
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
    GEOIP_VALIDATE_DB_PATH=false \
    LITESTAR_APP=geometrikks.server.core:create_app

VOLUME ["/app/data/geoip"]

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

STOPSIGNAL SIGTERM
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()" || exit 1

# The entrypoint remaps the geometrikks user to PUID/PGID (default
# 1000:1000), chowns /app/logs and /app/data/geoip, and drops privileges
# before exec-ing the CMD. With a non-root `user:` override it just execs.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Run with Granian via Litestar CLI
CMD ["litestar", "--app", "geometrikks.server.core:create_app", "run", "--host", "0.0.0.0", "--port", "8000"]
