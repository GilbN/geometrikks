# GeoMetrikks

**Status:** ⚠️ This project is in development. Features and APIs will change.

TLDR: GeoMetrikks is a real-time nginx access log ingestion and geo-location tracking service built with Litestar. It parses nginx access logs, performs GeoIP lookups, and stores geo-events and access logs in PostgreSQL with TimeScaleDB/PostGIS extensions.

Data is visualized with GeoJSON on a world map and on a summary dashbord.

## Backend

- Litestar
- TimescaleDB / PostGIS
- Maxmind DB GeoLite2

## Frontend

- React
- Vite
- TanStack
- MapLibre GL
- Carto base maps DarkMatter GL / Positron GL

### Planned features

- Basic auth
- Analytics page with different charts / stats etc
- More map filtering options (Country,City etc)
- Real time log feeds (Geolocation / Access Logs)
- Batch import of access log files
- Caching

#### Install deps

```
pip install uv
uv venv
uv sync --all-extras --dev
uvx nodeenv .venv --force --quiet
npm install --no-fund
```

#### Run dev server

```
docker-compose up -d
uv run litestar --app geometrikks.server.core:create_app run --debug
```
See .env.example for configuration

## Screenshots

![Overview](/data/screenshots/overview.png)

![Map](/data/screenshots/map.png)