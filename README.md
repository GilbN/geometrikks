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

```bash
pip install uv
uv venv
uv sync --all-extras --dev
uvx nodeenv .venv --force --quiet
npm install --no-fund
```

#### Run dev server

```bash
docker-compose up -d
uv run litestar --app geometrikks.server.core:create_app run --debug
```
See .env.example for configuration

## Sending Nginx log metrics

Nginx needs to be compiled with the geoip2 module: https://github.com/leev/ngx_http_geoip2_module

1. Add the following to the http block in your `nginx.conf` file:

    ```nginx
    geoip2 /config/geoip2db/GeoLite2-City.mmdb {
    auto_reload 5m;
    $geoip2_data_country_iso_code country iso_code;
    $geoip2_data_city_name city names en;
    }

    log_format custom '$remote_addr - $remote_user [$time_local]'
            '"$request" $status $body_bytes_sent'
            '"$http_referer" $host "$http_user_agent"'
            '"$request_time" "$upstream_connect_time"'
            '"$geoip2_data_city_name" "$geoip2_data_country_iso_code"';
    ```

2. Set the access log use the `custom` log format.

    ```nginx
    access_log /config/log/nginx/access.log custom;
    ```

### Multiple log files

If you separate your nginx log files but want this script to parse all of them you can do the following:

As nginx can have multiple `access log` directives in a block, just add another one in the server block. 

**Example**

```nginx
	access_log /config/log/nginx/somepage/access.log custom;
	access_log /config/log/nginx/access.log custom;
```
This will log the same lines to both files.

## Screenshots

![Overview](/data/screenshots/overview.png)

![Map](/data/screenshots/map.png)