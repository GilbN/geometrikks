# GeoMetrikks

![Map](/data/screenshots/live.png)

GeoMetrikks tails your nginx access logs, geolocates every request with
MaxMind GeoLite2, and gives you a real-time GeoIP map plus a traffic
analytics dashboard for your homelab - no external services, no
subscriptions, just Docker and your existing nginx logs. Run CrowdSec?
Hook up its Local API and manage bans right next to the traffic they
came from.

## Features

**Live map** - every ingested request lands on a MapLibre world map within
seconds; click a marker for the request, city, and ASN behind it.

![Map](/data/screenshots/map.png)

**Dashboard** - top-line traffic stats (requests, bytes, unique visitors,
status mix) at a glance, with a configurable date/time range.

![Dashboard](/data/screenshots/dashboard.png)

**Analytics** - request-volume, latency, and bytes-transferred charts, plus
top-URLs, top-user-agents, and status-code breakdowns.

![Analytics](/data/screenshots/analytics.png)

**Live feed** - a WebSocket-backed live tail on the access-logs page (new
rows prepend as they arrive, pause on hover) and a "Live" pulse overlay on
the map, both authenticated by the same session cookie as the REST API.

![Live tail](/data/screenshots/live-tail.png)

**Access logs** - a searchable, server-paginated history of every request:
free-text search across URL / referrer / user-agent, filters for status,
method, IP, host, country, and city, sortable columns, and a column picker
for the full log line (bytes, request time, upstream time, HTTP version,
and more).

![Access Logs](/data/screenshots/access-logs.png)

**CrowdSec integration** - point the app at your CrowdSec Local API for a
Security page showing active bans cross-referenced with your own traffic
(who's banned, and whether they're still knocking), a red banned-IP overlay
on the map, and ban/unban actions on any IP across the app - with badges
updating live from the decision stream. See
[CrowdSec integration](#crowdsec-integration-optional).

![CrowdSec](/data/screenshots/crowdsec.png)

**Batch import** - backfill rotated or archived logs (plain or `.gz`) with
`litestar import-logs`, reusing the same parsing/GeoIP/DB pipeline as live
tailing.

## Quickstart

All you need is Docker. The app image is published to GHCR for `amd64` and
`arm64`.

```bash
mkdir geometrikks && cd geometrikks
curl -LO https://raw.githubusercontent.com/GilbN/geometrikks/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/GilbN/geometrikks/main/.env.example
$EDITOR .env      # set APP_ADMIN_PASSWORD, MaxMind key, log path
docker compose up -d
```

Then open http://localhost:8000 and log in with `APP_ADMIN_USER` /
`APP_ADMIN_PASSWORD`. The GeoLite2 database is downloaded automatically at
startup when `MAXMINDDB_USER_ID` and `MAXMINDDB_LICENSE_KEY` are set and
refreshed weekly - see [MaxMind GeoLite2](#maxmind-geolite2) below. Without
credentials the app starts in geo-degraded mode (a banner in the UI explains
what to do); after adding credentials, restart the app container.

## Docker image tags

Images are published as `ghcr.io/gilbn/geometrikks`.

| Tag | Example | Meaning |
| --- | --- | --- |
| `latest` | `latest` | The newest stable release. |
| Exact stable version | `X.Y.Z` | A specific stable release; use this for reproducible deployments. |
| Major/minor stable version | `X.Y` | The newest stable patch release in a major/minor series. |
| Exact development version | `0.3.0-dev.2` | A specific prerelease build for testing upcoming changes. |
| `develop` | `develop` | The newest development release; a moving tag. |

Use `latest` to follow the newest stable release, or pin an exact version for
reproducible deployments:

```yaml
image: ghcr.io/gilbn/geometrikks:0.3.0
```

Development tags are intended for testing upcoming changes; production
installs should use a stable tag.

`docker-compose.yml` mounts `${NGINX_LOG_DIR:-/var/log/nginx}` read-only into
the container at `/var/log/nginx` and reads `LOGPARSER_LOG_PATHS` from
`.env`. Point `NGINX_LOG_DIR` at wherever your nginx (or reverse proxy)
writes its access logs.

## Nginx setup

GeoMetrikks parses a specific nginx `log_format`. Add it to the `http` block
in your `nginx.conf`:

```nginx
log_format custom '$remote_addr - $remote_user [$time_local] '
        '"$request" $status $body_bytes_sent '
        '"$http_referer" $host "$http_user_agent" '
        '"$request_time" "$upstream_response_time"';
```

Then use it on the access log you want GeoMetrikks to tail:

```nginx
access_log /config/log/nginx/access.log custom;
```

### Multiple log files

`LOGPARSER_LOG_PATHS` accepts a single path or a JSON list, so nginx can log
to more than one file and GeoMetrikks will tail all of them:

```nginx
access_log /config/log/nginx/somepage/access.log custom;
access_log /config/log/nginx/access.log custom;
```

```bash
LOGPARSER_LOG_PATHS=["/var/log/nginx/access.log", "/var/log/nginx/somepage/access.log"]
```

## MaxMind GeoLite2

GeoIP lookups use MaxMind's free GeoLite2 City database. Sign up for a free
account at [maxmind.com/en/geolite2/signup](https://www.maxmind.com/en/geolite2/signup)
and generate a license key, then set:

```bash
MAXMINDDB_USER_ID=<your-account-id>
MAXMINDDB_LICENSE_KEY=<your-license-key>
```

These are deliberately **not** prefixed `GEOIP_*` like the rest of the GeoIP
settings - they map onto MaxMind's own account-ID/license-key naming via
`validation_alias` in the settings model, matching the credentials shown on
your MaxMind account page.

On startup GeoMetrikks downloads the database automatically and refreshes it
weekly (`GEOIP_REFRESH_DAYS`, default 7) - no manual `.mmdb` handling needed.
Without credentials and without an existing database file, the app still
starts, but ingestion doesn't run and the UI shows a geo-degraded banner
until you add credentials and restart.

You must accept MaxMind's GeoLite2 EULA to use the database - see the
[MaxMind EULA](https://www.maxmind.com/en/geolite2/eula) for details.

## Authentication

GeoMetrikks ships with single-admin session-cookie authentication:

```bash
APP_ADMIN_USER=admin          # defaults to "admin"
APP_ADMIN_PASSWORD=           # required - the app refuses to start without it
```

Log in through the web UI (`/login`) or `POST /api/v1/auth/login`. Everything
under `/api/` requires a session; the SPA shell, `/health`, `/health/ready`,
and `/schema` stay open. **Sessions are held in memory**, so restarting the
app container logs everyone out - just log in again.

If an authenticating reverse proxy (Authelia, Tailscale, ...) already sits in
front of the app, you can disable the built-in auth entirely:

```bash
APP_AUTH_DISABLED=true  # only safe behind an authenticating reverse proxy
```

This is a reverse-proxy-only mode: with it set, `/api/v1/auth/*` stays
registered but stops doing anything. `GET /auth/me` reports
`{"mode": "disabled"}`, `POST /auth/login` returns that same payload without
establishing a session, `POST /auth/logout` is a 204 no-op, and the WebSocket
accepts anonymous connections, so only
enable it when something else is already gating access to the app.

## Running behind a reverse proxy

GeoMetrikks works behind a TLS-terminating reverse proxy. Serve it on its
own subdomain (for example `geometrikks.example.com`): the frontend is
hard-wired to the site root, so subfolder setups
(`example.com/geometrikks/`) are not supported.

Recommended settings when proxied over HTTPS:

```env
# The session cookie is only ever sent over HTTPS.
APP_SESSION_SECURE=true
# Trust X-Forwarded-For from your proxy so login logging records the real
# client IP. Use the narrowest range that covers the proxy.
APP_TRUSTED_PROXIES=172.18.0.0/16
```

`X-Forwarded-For` is a plain header any client can send, so GeoMetrikks
only honors it when the request arrives from an address listed in
`APP_TRUSTED_PROXIES`; otherwise the connection's own address is used.
Keep the range tight: everything inside it can put arbitrary addresses in
the header.

The WebSocket feeds (`/ws/live`, `/ws/crowdsec`) work through the standard
`Upgrade`/`Connection` proxy headers, and the server sends a keepalive
frame every 30 seconds, so idle connections survive nginx's default
`proxy_read_timeout` without extra tuning.

### Sample nginx configs

<details>
<summary>SWAG (linuxserver.io)</summary>

For [linuxserver SWAG](https://github.com/linuxserver/docker-swag), drop
this into `/config/nginx/proxy-confs/geometrikks.subdomain.conf` (the
GeoMetrikks container must be named `geometrikks` and share a Docker
network with SWAG):

```nginx
## Version 2025/07/18
# make sure that your geometrikks container is named geometrikks
# make sure that your dns has a cname set for geometrikks

server {
    listen 443 ssl;
#    listen 443 quic;
    listen [::]:443 ssl;
#    listen [::]:443 quic;

    server_name geometrikks.*;

    include /config/nginx/ssl.conf;

    client_max_body_size 0;

    # enable for ldap auth (requires ldap-location.conf in the location block)
    #include /config/nginx/ldap-server.conf;

    # enable for Authelia (requires authelia-location.conf in the location block)
    #include /config/nginx/authelia-server.conf;

    # enable for Authentik (requires authentik-location.conf in the location block)
    #include /config/nginx/authentik-server.conf;

    # enable for Tinyauth (requires tinyauth-location.conf in the location block)
    #include /config/nginx/tinyauth-server.conf;

    location / {
        # enable the next two lines for http auth
        #auth_basic "Restricted";
        #auth_basic_user_file /config/nginx/.htpasswd;

        # enable for ldap auth (requires ldap-server.conf in the server block)
        #include /config/nginx/ldap-location.conf;

        # enable for Authelia (requires authelia-server.conf in the server block)
        #include /config/nginx/authelia-location.conf;

        # enable for Authentik (requires authentik-server.conf in the server block)
        #include /config/nginx/authentik-location.conf;

        # enable for Tinyauth (requires tinyauth-server.conf in the server block)
        #include /config/nginx/tinyauth-location.conf;

        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app geometrikks;
        set $upstream_port 8000;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}
```

SWAG's stock `proxy.conf` already sends the WebSocket upgrade and
`X-Forwarded-For` headers. Set `APP_TRUSTED_PROXIES` to the Docker network
SWAG shares with the app (for example `172.18.0.0/16`).

</details>

<details>
<summary>Plain nginx</summary>

For a regular nginx install terminating TLS in front of the app:

```nginx
# The Connection header must be "upgrade" for WebSocket handshakes and
# "close" otherwise; this map picks the right value per request.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;

    server_name geometrikks.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade for /ws/live and /ws/crowdsec
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Adjust `proxy_pass` to wherever the app runs (container IP, another host).
With nginx proxying from the same machine as above, set
`APP_TRUSTED_PROXIES=127.0.0.1`.

</details>

Notes for exposing GeoMetrikks to the internet:

- `/schema` (the interactive API docs) and `/health` do not require login.
  If you don't want them public, protect them at the proxy (an nginx
  `location` rule or your auth portal).
- The login endpoint has no built-in rate limiting. Run fail2ban or
  CrowdSec against your proxy's access logs to stop brute force at the
  edge.
- `APP_AUTH_DISABLED=true` must only be used when an authenticating proxy
  (Authelia, Tailscale, ...) sits in front of the app.

## CrowdSec integration (optional)

If a [CrowdSec](https://www.crowdsec.net/) instance protects your stack,
GeoMetrikks can talk to its Local API (LAPI) and show active decisions
(bans) joined with the traffic data it already stores: per banned IP you see
the country/city and the request count from your actual nginx logs.

Register GeoMetrikks as a bouncer on the CrowdSec side and point the app at
the LAPI:

```bash
docker exec crowdsec cscli bouncers add geometrikks   # prints the API key
```

```bash
CROWDSEC_LAPI_URL=http://crowdsec:8080
CROWDSEC_BOUNCER_API_KEY=<key from cscli bouncers add>
```

That enables read-only access: a Security page (ban stats, the active
decision list cross-referenced with your own traffic data), the "Banned"
badge on matching IPs in the access-logs and top-IP tables, and a map
overlay marking banned IPs seen in your traffic within the selected time
range.

To also ban and unban from the UI, add machine credentials:

```bash
# -f - prints the credentials instead of overwriting the container's own
# /etc/crowdsec/local_api_credentials.yaml
docker exec crowdsec cscli machines add geometrikks --auto -f -
```

```bash
CROWDSEC_MACHINE_ID=geometrikks
CROWDSEC_MACHINE_PASSWORD=<password from cscli machines add>
```

With write access enabled, a shield button appears next to IPs across the
app (access logs, top-IP tables, map popups) with a ban-duration picker
(1h to forever) and an unban action for already-banned IPs, and the
Security page gains alert history plus a manual "Ban IP" dialog with an
optional reason. Manual bans are created with origin `geometrikks`, and
every ban/unban is audit-logged with the acting user in the app log.

Ban decisions are also streamed live: the app polls the LAPI decision
stream (every `CROWDSEC_STREAM_POLL_INTERVAL` seconds, default 15) and
pushes changes over a WebSocket, so badges react within seconds when
CrowdSec bans or unbans an IP anywhere, not just from this UI.

Notes:

- CrowdSec only *decides*; enforcement still needs a real bouncer
  (firewall-bouncer, nginx bouncer, Traefik plugin, ...) in front of your
  stack. GeoMetrikks displays and manages decisions, it does not block
  traffic itself.
- A machine that only logs in occasionally will show as "last seen" long ago
  in `cscli machines list` and the CrowdSec console. That's expected and
  harmless.
- Without `CROWDSEC_*` settings the integration is simply off; nothing else
  changes.

## Importing history

Live tailing only picks up lines written after the app starts. To backfill
history - rotated or archived nginx logs, plain or gzip-compressed - use the
`litestar import-logs` CLI command:

```bash
docker compose exec -u geometrikks app litestar import-logs /var/log/nginx/access.log.1.gz
```

It reuses the live ingestion pipeline (same parsing, GeoIP lookup, and DB
writes), uses the timestamps in each log line rather than wall-clock time,
and refreshes the continuous aggregates for the imported range when done.
Multiple files can be passed in one invocation; paths are **container**
paths, and the import runs as the non-root `geometrikks` user
(`PUID`:`PGID`, default 1000:1000), so host files must be readable by it
(`-u geometrikks` keeps `exec` from running the import as root).

`exec` requires the `app` service to already be running. If the stack is
stopped, use `run --rm` instead:

```bash
docker compose run --rm app litestar import-logs /var/log/nginx/access.log.1.gz
```

**Caveats**

- Import archived (rotated) files only - importing a file that's also being
  live-tailed **double-counts** its lines.
- Each imported file is fingerprinted by content checksum; importing the same
  content again (even under a different filename) is skipped. Pass `--force`
  to re-import - this updates the bookkeeping row but does **not** delete
  rows written by the earlier import.
- A file that doesn't match the expected log format is rejected up front,
  before anything is written.
- Rows older than the raw retention window (`ANALYTICS_RAW_RETENTION_DAYS`,
  default 180 days) are dropped by the TimescaleDB retention policy -
  importing history beyond that window won't persist. Raise the retention
  setting before importing older archives if you want to keep them.

## Configuration

`.env.example` covers the short list most installs need to touch (admin
credentials, MaxMind key, log paths, DB password). For the full set of
environment variables - every default, every setting - see
[`docs/configuration.md`](docs/configuration.md).

Set `GEOMETRIKKS_ENV_FILE` to load a different `.env` path, or to an empty
value to disable dotenv loading and configure through real environment
variables only.

### PUID and PGID

The container starts as root just long enough to re-map its internal user to
`PUID`:`PGID` (default `1000:1000`), fix ownership of `/app/logs` and the
GeoIP volume, and then drops privileges - the app process itself never runs
as root. Set `PUID`/`PGID` in `.env` to the user that should own `./logs` on
the host (usually your own: `id -u` / `id -g`).

Running in an environment that forbids root entirely (rootless Docker,
hardened setups)? Set a `user:` on the `app` service in the compose file;
the entrypoint detects it, skips the re-mapping, and just runs the app as
that user. You are then back to managing `./logs` ownership yourself.

Want to harden further? The entrypoint only needs the capabilities the
remap itself uses, and `gosu` is not a setuid binary, so both of these are
verified working combinations. With PUID/PGID re-mapping:

```yaml
  app:
    # ...
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
```

Or with a `user:` override, where the image needs no capabilities at all:

```yaml
  app:
    # ...
    user: "1000:1000"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

## FAQ

**I'm using Nginx Proxy Manager (or another proxy-manager container) - what
log path do I use?**
Point `NGINX_LOG_DIR` at the host directory where the proxy container writes
its access logs (for Nginx Proxy Manager this is typically its `data/logs`
volume), and set `LOGPARSER_LOG_PATHS` to the specific access-log file(s)
inside it, using the *container* path (`/var/log/nginx/...`), not the host
path.

**Permission denied reading my log files?**
The app container runs as `PUID`:`PGID` (default 1000:1000), and log mounts
are read-only. Make sure the log files (and their parent directory) are
readable by that uid/gid on the host - `chmod`/`chown` or an ACL entry,
whichever fits your setup. Read-only mounts are intentional: GeoMetrikks never needs to write to
your nginx logs.

**Does this run on arm64?**
Yes - the published GHCR image is a multi-arch manifest for `linux/amd64`
and `linux/arm64`.

**The map is empty.**
Check three things in order: (1) the geo-degraded banner - if it's showing,
MaxMind credentials or the GeoLite2 database are missing; (2) that
`LOGPARSER_LOG_PATHS` actually points at a file receiving traffic, matching
the `log_format` above; (3) that some time has passed since you last
restarted - the map only shows events ingested after startup unless you've
run a batch import.

**What does the "geo-degraded" banner mean?**
It means the app started without a usable GeoLite2 database - either
`MAXMINDDB_USER_ID`/`MAXMINDDB_LICENSE_KEY` aren't set, or the download
hasn't completed yet. The API and UI stay up, but log ingestion doesn't
start until a database is available. Add credentials and restart the app
container to clear it; the sidebar's connection indicator also shows
"Degraded" while ingestion is stopped.

## Development

```bash
pip install uv
uv venv
uv sync --all-extras --dev
bun install
```

Run the dev database, then the app:

```bash
docker compose -f docker-compose.dev.yml up -d timescale_db
uv run litestar --app geometrikks.server.core:create_app run --debug
```

(`docker-compose.dev.yml` also has an `app-dev`/`dev` profile that builds and
hot-reloads the whole stack in Docker via `Dockerfile.dev`, if you'd rather
not run the app bare-metal.) Run it with:

```bash
docker compose -f docker-compose.dev.yml --profile dev up --build
```

To inspect the live route animation without generating log traffic, open the
map with the development-only demo harness. It uses fixed worldwide origins,
turns Live mode on automatically, and does not connect to the live-feed
WebSocket:

```text
http://localhost:8000/map?demoTraffic=1       # steady traffic
http://localhost:8000/map?demoTraffic=burst   # overlapping bursts
```

The query parameter is ignored by production builds.

The live route destination defaults to the GeoIP location of the app server's
public IP. GeoMetrikks discovers that address once at startup through ipify and
looks it up in the local GeoLite2 database. If the logs come from another
server, set both `MAP_HOME_LATITUDE` and `MAP_HOME_LONGITUDE`. Set
`MAP_AUTO_DETECT_HOME=false` to disable the outbound lookup entirely. The map's
**Route effects** control can also hide the animation; that preference is kept
in browser storage.

### Testing

```bash
uv run pytest                    # unit tests - no docker needed
```

Integration tests need the compose TimescaleDB and are marked `integration`.
When the database is unreachable they're skipped automatically, so the plain
run above always stays green.

```bash
docker compose -f docker-compose.dev.yml up -d timescale_db
uv run pytest -m integration     # the real-database suite
```

The integration suite creates a scratch database `geometrikks_it` on the
compose server (migrated to alembic head + timescale objects) and drops it at
session end - it never touches the `geometrikks` dev database. Connection
overrides: `IT_DB_HOST`, `IT_DB_PORT`, `IT_DB_USER`, `IT_DB_PASSWORD`.

CI (`.github/workflows/ci.yml`) runs the integration suite against a
`timescale/timescaledb-ha:pg18` service container via the `IT_DB_*` env vars.
