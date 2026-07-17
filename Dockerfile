# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Stage 1: Build frontend assets
# ------------------------------------------------------------------------------
# --platform=$BUILDPLATFORM: the vite/tsc output is architecture-independent,
# so always build it natively instead of under QEMU emulation (bun is slow and
# flaky when emulated during multi-arch release builds).
FROM --platform=$BUILDPLATFORM oven/bun:latest AS frontend-builder

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

WORKDIR /app

COPY --from=python-builder /app/.venv /app/.venv
COPY --from=python-builder /app/geometrikks /app/geometrikks
COPY --from=frontend-builder /app/public /app/public
COPY --from=frontend-builder /app/index.html /app/public/index.html
COPY pyproject.toml alembic.ini ./
COPY migrations/ ./migrations/

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

USER geometrikks

STOPSIGNAL SIGTERM
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()" || exit 1

# Run with Granian via Litestar CLI
CMD ["litestar", "--app", "geometrikks.server.core:create_app", "run", "--host", "0.0.0.0", "--port", "8000"]
