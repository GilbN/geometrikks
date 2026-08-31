<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="resources/static/brand/readme-banner-light.png">
    <img src="resources/static/brand/readme-banner-dark.png" alt="GeoMetrikks">
  </picture>
</h1>

![Map](/data/screenshots/live.png)

GeoMetrikks tails your reverse-proxy access logs (nginx, Traefik and Caddy),
geolocates every request with MaxMind GeoLite2, and shows the result on a
real-time map and a traffic analytics dashboard. It runs on your own
hardware from one Docker image. Outbound traffic is the GeoLite2 download
and, unless you disable it, a public-IP lookup for the map's home location.
If you run CrowdSec, connect its Local API and manage bans next to the
traffic that caused them.

## Features

**Live map.** Every ingested request lands on a MapLibre world map within
seconds. Click a marker for the request, city, and ASN behind it. With
several sources, filter the map by source hostname and watch live routes
fly to each site's own home beacon (see
[Multi-source setup](#multi-source-setup)).

![Map](/data/screenshots/map.png)

**Overview.** Requests, bytes, unique visitors and status mix for the
selected time range, with trends against the previous range.

![Overview](/data/screenshots/dashboard.png)

**Analytics.** Request volume, latency and bytes-transferred charts; top
URLs (one row per host and path), user agents and status codes; and a
Top ASNs view showing which networks your traffic comes from and how
much of it arrives from hosting providers. Latency figures skip
WebSocket connections (status 101) and connections that ended without a
response (status 0). Their logged time covers the whole connection, not
the response, and the rows stay in Access logs with that duration.

![Analytics](/data/screenshots/analytics.png)

**Live feed.** A WebSocket-backed live tail on the access-logs page (new
rows prepend as they arrive and pause while you hover) and a live pulse
overlay on the map.

![Live tail](/data/screenshots/live-tail.png)

**Access logs.** A searchable, server-paginated history of every request:
free-text search across URL, referrer and user agent; filters for status,
method, IP, host, country, city, recording hostname and source format;
sortable columns; and a column picker for the full log line (bytes,
request time, upstream time, HTTP version and more). Select a row for the
complete record.

![Access Logs](/data/screenshots/access-logs.png)

**Geo logs.** Traffic grouped by location: which places send requests, how
that changes over time, and which clients keep coming back, with Top IPs
and Top locations next to a map preview and an event chart.

![Geo Logs](/data/screenshots/geo-logs.png)

**Debug logs.** The raw source lines behind every request, with parse
failures called out and linked to their request. This is where to look when
a log file is not producing events.

![Debug Logs](/data/screenshots/debug-logs.png)

**Multi-source.** Several proxies or hosts? Run one full instance plus
lightweight agents next to each log file, or tail shipped files from one
place. Every page can filter by the recording hostname, and the map gives
each site its own home beacon. See [Multi-source setup](#multi-source-setup).

**Settings > Status.** Ingestion, storage, enrichment, integrations and
live services on one page, with advisories when something needs attention
(a missing ASN database, a source whose home could not be detected).

**CrowdSec integration.** Point the app at your CrowdSec Local API for a
Security page that cross-references active bans with your own traffic (who
is banned, and whether they are still knocking), a banned-IP overlay on the
map, and ban/unban actions on any IP across the app. Badges update live
from the decision stream. See
[CrowdSec integration](#crowdsec-integration-optional).

![CrowdSec](/data/screenshots/crowdsec.png)

**Batch import.** Backfill rotated or archived logs (plain or `.gz`) with
`litestar import-logs`.

## Quickstart

You need Docker. The image is published to GHCR for `amd64` and `arm64`.

```bash
mkdir geometrikks && cd geometrikks
curl -LO https://raw.githubusercontent.com/GilbN/geometrikks/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/GilbN/geometrikks/main/.env.example
$EDITOR .env      # set APP_ADMIN_PASSWORD, MaxMind key, log path
docker compose up -d
```

Open http://localhost:8000 and log in with `APP_ADMIN_USER` /
`APP_ADMIN_PASSWORD`. When `MAXMINDDB_USER_ID` and `MAXMINDDB_LICENSE_KEY`
are set, the app downloads the GeoLite2 database at startup and refreshes
it weekly (see [MaxMind GeoLite2](#maxmind-geolite2)). Without credentials
it starts in geo-degraded mode and a banner in the UI explains what to do;
after adding credentials, restart the app container.

## Docker image tags

Images are published as `ghcr.io/gilbn/geometrikks`.

| Tag | Example | Meaning |
| --- | --- | --- |
| `latest` | `latest` | The newest stable release. |
| Exact stable version | `X.Y.Z` | A specific stable release; use this for reproducible deployments. |
| Major/minor stable version | `X.Y` | The newest stable patch release in a major/minor series. |
| Exact development version | `0.13.0-dev.1` | A specific prerelease build for testing upcoming changes. |
| `develop` | `develop` | The newest development release; a moving tag. |

Use `latest` to follow stable releases, or pin an exact version:

```yaml
image: ghcr.io/gilbn/geometrikks:0.13.0
```

`docker-compose.yml` mounts `ACCESS_LOG_DIR` (default `/var/log/nginx`)
read-only into the container at `/var/log/access` and reads
`LOGPARSER_LOG_PATHS` from `.env`. Point `ACCESS_LOG_DIR` at wherever your
reverse proxy writes its access logs. `LOGPARSER_LOG_PATHS` must name the
file(s) as seen inside the container, under `/var/log/access/`.

## Nginx setup

GeoMetrikks reads a keyed JSON access log. Add this `log_format` to the
`http` block in your `nginx.conf` (nginx 1.11.8 or later for `escape=json`):

```nginx
log_format geometrikks_json escape=json
  '{'
    '"client_ip":"$remote_addr",'
    '"timestamp":"$time_iso8601",'
    '"method":"$request_method",'
    '"path":"$request_uri",'
    '"protocol":"$server_protocol",'
    '"status":"$status",'
    '"bytes":"$body_bytes_sent",'
    '"host":"$host",'
    '"referrer":"$http_referer",'
    '"user_agent":"$http_user_agent",'
    '"remote_user":"$remote_user",'
    '"request_time":"$request_time",'
    '"upstream_time":"$upstream_response_time",'
    '"request_raw":"$request"'
  '}';
```

Then use it on the access log you want GeoMetrikks to tail:

```nginx
access_log /config/log/nginx/access.log geometrikks_json;
```

Keep every value quoted, including the numbers: nginx has no typed output,
and an unquoted empty variable breaks the line. `escape=json` is required;
without it a quote inside a user agent produces invalid JSON, and the line
is skipped and counted as unparseable. `escape=json` leaves bytes above
0x7f raw, so a probe line can carry undecodable bytes; GeoMetrikks
replaces them with U+FFFD and still classifies the line. `client_ip` and
`timestamp` are the only required keys. Drop any other key and the feature
it feeds goes empty (`host` feeds the host filter, `request_time` and
`upstream_time` feed the response-time analytics). Add your own keys
freely; GeoMetrikks ignores the ones it does not know.

`LOGPARSER_LOG_FORMATS=geometrikks-json` pins the parser to this format
instead of detecting it per file.

`$remote_addr` is only the visitor's address if nginx sees the visitor
directly. Behind a CDN, tunnel, or another proxy, see
[docs/proxy-setup.md](docs/proxy-setup.md) for the realip config that logs
the visitor instead of that hop.

### Legacy nginx format

Earlier versions documented this positional format. It keeps working for
both live tailing and `import-logs`, so an existing install needs no
change, and archives already written in it import as before. Use the JSON
format above for new setups.

```nginx
log_format custom '$remote_addr - $remote_user [$time_local] '
        '"$request" $status $body_bytes_sent '
        '"$http_referer" $host "$http_user_agent" '
        '"$request_time" "$upstream_response_time"';
```

The parser matches this format on position and quoting rather than on
field names, so a rearranged format can land values in the wrong columns
instead of failing outright. Four rules:

- Use `$time_local`. `$time_iso8601` does not match at all, and a file that
  uses it produces no rows.
- Keep `$host` unquoted and between `"$http_referer"` and
  `"$http_user_agent"`. Writing `"$host"` still parses, but the hostname
  ends up in the user-agent column and `host` comes out empty.
- Keep `$request_time` and `$upstream_response_time` quoted. Unquoted, both
  are dropped and read as 0.
- Append extra fields only after both timing fields. The parser fills the
  two timing slots by quoting alone, so on a format without them an extra
  quoted field lands in `$request_time`. A non-numeric value such as
  `"$http_x_forwarded_for"` is discarded, but a numeric one is recorded and
  charted as a response time.

`LOGPARSER_LOG_FORMATS=nginx` pins the parser to this format.

#### Backfilling logs written in another format

Lines in nginx's built-in `combined` format also parse, so you can import
archives you have on disk without having changed your nginx config first.
Three fields are absent from those lines and cannot be recovered after the
fact:

| Missing field | What it costs you |
| --- | --- |
| `$host` | The host filter on the access-log and analytics pages has nothing to list |
| `$request_time` | Response-time cards show n/a for those rows; rows imported by earlier versions carry a placeholder 0.0 that `backfill-timings` clears |
| `$upstream_response_time` | Upstream timing stays empty in the access-log detail view |

The map, geo analytics, status codes, URLs, referrers, user agents and bytes
are unaffected.

### Multiple log files

`LOGPARSER_LOG_PATHS` accepts a single path or a JSON list, so nginx can log
to more than one file and GeoMetrikks tails all of them:

```nginx
access_log /config/log/nginx/somepage/access.log geometrikks_json;
access_log /config/log/nginx/access.log geometrikks_json;
```

```bash
LOGPARSER_LOG_PATHS=["/var/log/access/access.log", "/var/log/access/somepage/access.log"]
```

## Traefik setup

GeoMetrikks parses Traefik JSON access logs. Traefik logs to stdout by
default, so configure a file and the JSON format in your static
configuration, and keep the User-Agent and Referer headers so analytics
have them:

```yaml
accessLog:
  filePath: "/var/log/traefik/access.log"
  format: json
  fields:
    headers:
      names:
        User-Agent: keep
        Referer: keep
```

Mount the log directory into the GeoMetrikks container (set
`ACCESS_LOG_DIR=/path/to/traefik/logs` in `.env`, or edit the volume) and
point the parser at it:

```env
ACCESS_LOG_DIR=/var/log/traefik
LOGPARSER_LOG_PATHS=/var/log/access/access.log
```

The format is auto-detected per file; set `LOGPARSER_LOG_FORMATS=traefik-json`
to pin it. Notes:

- Rotate with logrotate and signal Traefik afterwards:
  `docker kill --signal=USR1 traefik`. GeoMetrikks follows the rotation.
- Behind a CDN or load balancer, configure Traefik's
  `entryPoints.<name>.forwardedHeaders.trustedIPs` so the logged client IP
  is the real client, not the proxy. With a trusted peer, Traefik logs the
  `X-Forwarded-For` chain as it arrived; GeoMetrikks takes the rightmost
  entry, the one your proxy appended. Do not set `forwardedHeaders.insecure`:
  it trusts the header from anyone, and a client can then place any address
  on the map. See `docs/proxy-setup.md` for the full real-IP setup,
  including tunnels.
- A file path is required; GeoMetrikks cannot read Traefik's stdout.

## Caddy setup

GeoMetrikks parses Caddy's native JSON access logs. Caddy logs to stderr
by default, so give the site (or a wildcard site block) a `log` directive
that writes to a file:

```caddyfile
example.com {
    log {
        output file /var/log/caddy/access.log
        format json
    }
}
```

Mount the log directory into the GeoMetrikks container and point the
parser at it:

```env
ACCESS_LOG_DIR=/var/log/caddy
LOGPARSER_LOG_PATHS=/var/log/access/access.log
```

The format is auto-detected per file; set `LOGPARSER_LOG_FORMATS=caddy-json`
to pin it. Notes:

- Caddy rotates the log file itself by default; GeoMetrikks follows the
  rotation.
- Behind a CDN or another proxy, set `trusted_proxies` under `servers` in
  Caddy's global options. Caddy then resolves the visitor's address into
  the logged `client_ip`, which is the field GeoMetrikks reads (falling
  back to `remote_ip` on logs from Caddy older than 2.7). Without it the
  log carries the proxy's address and the map shows the proxy. See
  `docs/proxy-setup.md`.
- Keep the json encoder's `time_format` at its default or any ISO variant,
  and `duration_format` at its default. Lines with `wall`, `common_log` or
  custom time layouts are skipped, and a non-default `duration_format`
  loses response times.

## MaxMind GeoLite2

GeoIP lookups use MaxMind's free GeoLite2 City database. Sign up at
[maxmind.com/en/geolite2/signup](https://www.maxmind.com/en/geolite2/signup),
generate a license key, then set:

```bash
MAXMINDDB_USER_ID=<your-account-id>
MAXMINDDB_LICENSE_KEY=<your-license-key>
```

On startup GeoMetrikks downloads the database and refreshes it every
`GEOIP_REFRESH_DAYS` (default 7). You never handle `.mmdb` files yourself.

Both the GeoLite2 City and GeoLite2 ASN databases are downloaded: City
powers the map and geo analytics, ASN adds the network and organization
behind each request. Set `GEOIP_ASN_ENABLED=false` to skip the ASN database.

Using the database means accepting the
[MaxMind GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula).

## Authentication

GeoMetrikks ships with single-admin session-cookie authentication:

```bash
APP_ADMIN_USER=admin          # defaults to "admin"
APP_ADMIN_PASSWORD=           # required; the app refuses to start without it
```

![Login](/data/screenshots/login.png)

Log in through the web UI (`/login`) or `POST /api/v1/auth/login`. Everything
under `/api/` and `/ws/` requires a session; the web app's static files
(you need them to reach the login page), `/health`, `/health/ready` and
`/schema` stay open. **Sessions are held in memory**, so
restarting the app container logs everyone out.

If something else already controls who reaches the app (an authenticating
proxy such as Authelia or Tailscale, or a network only you can reach), you
can turn the built-in auth off:

```bash
APP_AUTH_DISABLED=true
```

There is then no login and no session: anyone who can reach the app has full
access to it and to the WebSocket feeds.

## Running behind a reverse proxy

GeoMetrikks works behind a TLS-terminating reverse proxy. Serve it on its
own subdomain (for example `geometrikks.example.com`). The frontend is
built for the site root, so subfolder setups (`example.com/geometrikks/`)
do not work.

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
`APP_TRUSTED_PROXIES`; otherwise it uses the connection's own address. Keep
the range tight: everything inside it can put arbitrary addresses in the
header.

`APP_TRUSTED_PROXIES` only affects the app's own login logging; it has no
effect on how the log parser reads your proxy's access log files. For
getting the real visitor address into those log files, see
`docs/proxy-setup.md`.

The WebSocket feeds (`/ws/live`, `/ws/crowdsec`, `/ws/logs`) work through
the standard `Upgrade`/`Connection` proxy headers, and idle connections
survive nginx's default `proxy_read_timeout` without extra tuning.

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

        # WebSocket upgrade for /ws/live, /ws/crowdsec and /ws/logs
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Adjust `proxy_pass` to wherever the app runs (container IP, another host).
With nginx on the same machine as above, set
`APP_TRUSTED_PROXIES=127.0.0.1`.

</details>

Notes for exposing GeoMetrikks to the internet:

- `/schema` (the interactive API docs) and `/health` do not require login.
  If you don't want them public, protect them at the proxy (an nginx
  `location` rule or your auth portal).
- The login endpoint has no built-in rate limiting. Run fail2ban or
  CrowdSec against your proxy's access logs to stop brute force at the
  edge.
- Use `APP_AUTH_DISABLED=true` only when an authenticating proxy (Authelia,
  Tailscale, ...) sits in front of the app.

## CrowdSec integration (optional)

If a [CrowdSec](https://www.crowdsec.net/) instance protects your stack,
GeoMetrikks can talk to its Local API (LAPI) and show active decisions
(bans) joined with the traffic it already stores: for each banned IP you
see the country, city and request count from your own access logs.

Register GeoMetrikks as a bouncer on the CrowdSec side and point the app at
the LAPI:

```bash
docker exec crowdsec cscli bouncers add geometrikks   # prints the API key
```

```bash
CROWDSEC_LAPI_URL=http://crowdsec:8080
CROWDSEC_BOUNCER_API_KEY=<key from cscli bouncers add>
```

That gives read-only access: a Security page (ban stats and the active
decision list cross-referenced with your traffic), a "Banned" badge on
matching IPs in the access-logs and top-IP tables, and a map overlay
marking banned IPs seen in your traffic within the selected time range.

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

With write access, a shield button appears next to IPs across the app
(access logs, top-IP tables, map popups) with a ban-duration picker (1h to
forever) and an unban action for banned IPs, and the Security page gains
alert history and a manual "Ban IP" dialog with an optional reason. Manual
bans carry origin `geometrikks`, and every ban and unban is audit-logged
with the acting user.

Ban decisions stream live: the app polls the LAPI decision stream every
`CROWDSEC_STREAM_POLL_INTERVAL` seconds (default 15) and pushes changes
over a WebSocket, so badges react within seconds when CrowdSec bans or
unbans an IP anywhere, not only from this UI.

> [!NOTE]
> CrowdSec only *decides*; enforcement still needs a real bouncer
> (firewall-bouncer, nginx bouncer, Traefik plugin, ...) in front of your
> stack. GeoMetrikks displays and manages decisions; it does not block
> traffic.

A machine that only logs in occasionally shows a "last seen" long ago in
`cscli machines list` and the CrowdSec console. That is expected. Without
`CROWDSEC_*` settings the integration is off and nothing else changes.

## Multi-source setup

If traffic comes in through more than one reverse proxy or host, GeoMetrikks
can run as one full instance plus lightweight agents instead of one instance
tailing everything remotely. Each agent runs next to its own access logs
(same host or Docker network as the proxy it tails) and does the ingestion
locally: tail, parse, geolocate, write, publish. One full instance owns
everything else: the UI, the API, database migrations, the scheduler, and
CrowdSec. Every agent and the full instance share one TimescaleDB. The live
map stays in sync whichever process ingested a request, because every
writer publishes committed events over PostgreSQL LISTEN/NOTIFY and the
full instance's `/ws/live` feed relays all of them.

Agents are not the only shape. If the log files already reach one machine
(a shared mount, rsyslog, log shipping), a single full instance can tail
them all and keep the sources apart by giving `LOGPARSER_HOST_NAME` a JSON
list matched positionally to `LOGPARSER_LOG_PATHS`:

```bash
LOGPARSER_LOG_PATHS=["/var/log/access/edge-01.log", "/var/log/access/edge-02.log"]
LOGPARSER_HOST_NAME=["edge-01", "edge-02"]
```

Everything downstream (the access-logs hostname filter, the map's Source
filter, per-site homes) treats those files like traffic from separate
agents.

An agent needs only `APP_MODE=agent`, database credentials for the shared
instance, GeoIP credentials, and its own log mount:

```yaml
services:
  agent:
    image: ghcr.io/gilbn/geometrikks:0.13.0   # same tag as the full instance
    restart: unless-stopped
    stop_grace_period: 20s
    environment:
      APP_MODE: agent
      DB_HOST: timescale.example.internal
      DB_PORT: "5432"
      DB_USER: geouser
      DB_PASSWORD: ${DB_PASSWORD}
      DB_DATABASE: geometrikks
      MAXMINDDB_USER_ID: ${MAXMINDDB_USER_ID}
      MAXMINDDB_LICENSE_KEY: ${MAXMINDDB_LICENSE_KEY}
      LOGPARSER_LOG_PATHS: '["/var/log/access/access.log"]'
      LOGPARSER_HOST_NAME: edge-01
    volumes:
      - geoip_data:/app/data/geoip
      - /var/log/nginx:/var/log/access:ro
    healthcheck:
      # The image's own healthcheck probes /health, which answers 200 for
      # the whole schema wait. /health/ready is the one that reports 503
      # while the agent waits for the primary to migrate.
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/health/ready', timeout=5).read()\" || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      # The schema gate runs inside ASGI startup, so the port does not
      # accept at all for up to 120s. Without this grace window the first
      # probes fail a perfectly healthy cold start.
      start_period: 150s

volumes:
  geoip_data:
```

`APP_MODE=agent` is a headless process: it tails, geolocates, writes and
publishes like a full instance, but serves only `/health` and
`/health/ready`. No UI, no API, no OpenAPI schema, no session auth, so it
needs no `APP_ADMIN_PASSWORD`. It downloads and refreshes its own GeoLite2
database, so it needs MaxMind credentials and a geoip volume. It never runs
migrations or creates TimescaleDB objects; its writes are events and its
own site-homes row. At startup it waits for the
shared database's schema to reach the revision it was built against. If
that wait times out, the agent stays up in degraded mode rather than
exiting, with `/health` answering 200 and `/health/ready` answering 503. An
orchestrator with a readiness probe restarts it into a fresh wait; without
one, restart the agent container yourself once the full instance has
finished migrating.

Compose does not act on health status, so on plain Docker the probe above
shows a stuck agent as `unhealthy` in `docker ps` and gates any
`depends_on: condition: service_healthy` you add. Turning that signal into a
restart takes Swarm, Kubernetes, or an autoheal sidecar. `restart:
unless-stopped` will not do it: it reacts to a container exiting, and a
waiting agent stays up.

CDN peer advisories for an agent's tailed sources reach the head's
Settings > Status page. The head scans the shared database's last hour of
access-log rows every 5 minutes, covering only sources with
`LOGPARSER_SEND_LOGS=true`. Private-peer advisories still surface only on
the agent's own `/health` and logs, since those lines are never stored. See
`docs/proxy-setup.md` for details.

The reverse case works too. To keep a full instance's UI and API without it
tailing local files (a machine that only hosts the app, with all traffic
ingested by agents elsewhere), set:

```bash
LOGPARSER_ENABLED=false
```

It still serves the UI, API, migrations, scheduler and CrowdSec; it never
tails a log file itself.

**Site homes.** Live map routes fly to the home location of the source that
recorded them, one beacon per site. Each ingesting instance detects its own
public-IP location and re-checks it every `MAP_HOME_REFRESH_HOURS` (default
24h). When detection is wrong for a source (CGNAT, a VPN egress, or logs
shipped from another machine), pin that hostname on the full instance with
`MAP_HOME_LOCATIONS`, for example
`MAP_HOME_LOCATIONS={"edge-01": [60.39, 5.32]}`. Overrides win over
detection, and removing one restores it. Settings > Status lists each
source's home and whether it came from detection or an override.

> [!WARNING]
> **Trust model.** Agents authenticate with the database using ordinary
> database credentials, and the app does not care where data comes from.
> Anyone who can run an agent has full read/write access to the entire
> database: all traffic history from every source, any hostname, no tenant
> isolation, no per-agent identity, and no revocation short of rotating the
> shared password. Sharing one instance across parties works as long as
> everyone understands they share everything. Run agent connections over a
> VPN or tailnet, not the open internet.

**Keep versions aligned.** Run the same image tag on every agent and the
full instance. An agent tolerates the shared database running slightly
ahead of its own bundled schema (a full instance mid rolling-restart) by
logging a warning and proceeding rather than refusing to start. That is an
allowance for a brief mismatch, not a reason to run agents and the full
instance on different versions.

**CrowdSec.** Point `CROWDSEC_LAPI_URL` and the bouncer/machine credentials
(see [CrowdSec integration](#crowdsec-integration-optional)) at the central
LAPI on the full instance only; per-machine CrowdSec agents keep reporting
to that same LAPI as usual. GeoMetrikks agents ignore `CROWDSEC_*` settings;
ban visibility and management stay with the full instance.

## CLI commands

Besides the server, the image ships maintenance commands under the
`litestar` CLI. Run them inside the container with
`docker compose exec -u geometrikks app litestar <command>` (or
`docker compose run --rm app litestar <command>` when the stack is
stopped). The image sets `LITESTAR_APP` so the bare command works there;
outside the container, point the CLI at the app yourself:
`uv run litestar --app geometrikks.server.core:create_app <command>`.
Every command supports `--help`.

### import-logs: backfill history

Live tailing only picks up lines written after the app starts. To backfill
rotated or archived access logs (nginx, Traefik JSON or Caddy JSON, plain
or gzip), use `import-logs`:

```bash
docker compose exec -u geometrikks app litestar import-logs /var/log/access/access.log.1.gz
```

It reuses the live ingestion pipeline (same parsing, GeoIP lookup and DB
writes), uses the timestamps in each log line rather than wall-clock time,
and refreshes the continuous aggregates for the imported range when done.
The log format is auto-detected per file, as with live tailing; pass
`--format geometrikks-json`, `--format nginx`, `--format traefik-json` or
`--format caddy-json` to pin it. You can pass several
files in one invocation. Paths are **container** paths, and the import runs
as the non-root `geometrikks` user (`PUID`:`PGID`, default 1000:1000), so
host files must be readable by it (`-u geometrikks` keeps `exec` from
running the import as root).

`exec` requires the `app` service to be running. If the stack is stopped,
use `run --rm` instead:

```bash
docker compose run --rm app litestar import-logs /var/log/access/access.log.1.gz
```

> [!IMPORTANT]
> Import archived (rotated) files only. Importing a file that is also being
> live-tailed **double-counts** its lines.

- Each imported file is fingerprinted by content checksum; importing the
  same content again (even under a different filename) is skipped. Pass
  `--force` to re-import. That updates the bookkeeping row but does **not**
  delete rows written by the earlier import.
- A file that matches no supported log format is rejected up front, before
  anything is written.
- Without `--format`, the format is detected per file. If detection can only
  match the relaxed IP-and-timestamp pattern, the file imports as map events
  with no access-log rows. Pin the format (`--format geometrikks-json` or
  `--format nginx`) to require a full parse; lines that do not match then
  show up in the skipped count instead.
- The TimescaleDB retention policy drops rows older than the raw retention
  window (`ANALYTICS_RAW_RETENTION_DAYS`, default 180 days), so history
  beyond that window will not persist. Raise the retention setting before
  importing older archives if you want to keep them.

### backfill-hostname: fix up historical hostnames

Every ingested row records which GeoMetrikks instance wrote it
(`LOGPARSER_HOST_NAME`; defaults to the machine hostname, which the compose
file pins to `geometrikks`). Rows ingested by older versions have no
hostname, so the access-logs hostname filter cannot see them.
`backfill-hostname` stamps them retroactively:

```bash
docker compose exec -u geometrikks app litestar backfill-hostname myhost
```

The plain form fills **only** rows with no hostname. It is idempotent,
cannot overwrite stamped values, and runs immediately without a
confirmation prompt.

If your database has accumulated many bogus hostnames, add
`--consolidate` to rewrite **all** existing hostnames to the given name as
well. The classic cause is running in Docker with `LOGPARSER_HOST_NAME`
unset before the compose file pinned a hostname: every container
recreation minted a new 12-hex container-ID "hostname". Consolidate lists
every hostname it will rewrite, with row counts, and asks for confirmation
first (`--yes` skips the prompt):

```bash
docker compose exec -u geometrikks app litestar backfill-hostname myhost --consolidate
```

Either form decompresses compressed history chunks first (a full-table
update would trip TimescaleDB's tuple decompression limit), so disk usage
grows until the compression policy recompresses them. It then refreshes the
affected continuous aggregates so the filter dropdowns update. It may run
for minutes on a large database.

### backfill-asn: fill in ASN data for historical rows

Rows ingested before the ASN feature (or while the ASN database was
missing) have no ASN data. `backfill-asn` resolves their IPs against the
local GeoLite2 ASN database and stamps them retroactively:

```bash
docker compose exec -u geometrikks app litestar backfill-asn
```

It fills **only** rows with no ASN data (idempotent, never overwrites
stamped values) and asks for confirmation after reporting how many rows and
distinct IPs are affected (`--yes` skips the prompt). IPs the database
cannot resolve stay empty. Like `backfill-hostname`, it decompresses
compressed history chunks first (disk usage grows until the compression
policy recompresses them) and refreshes the ASN continuous aggregates
afterwards so the Top ASNs view picks up the history. It may run for
minutes on a large database.

If the aggregate refresh fails, the command exits non-zero and names the
stale aggregates: the rows are stamped, but the Top ASNs view will not show
the backfilled range until they refresh. Rerunning is safe.

Today's ASN database describes today's network ownership; stamping
years-old traffic with it is an approximation.

### backfill-timings: clear placeholder response times

Archives in nginx's built-in `combined` format have no `$request_time`.
Older versions stored those rows with a response time of 0.0, which
dragged every average and percentile toward zero. Rows ingested by this
version store no timing at all for such lines; `backfill-timings` does
the same for the rows that predate it:

```bash
docker compose exec -u geometrikks app litestar backfill-timings
```

It only touches rows the legacy nginx format wrote without a host, which is
how a `combined` line looks after import (the custom format always logs
`$host`), and whose response time is exactly 0. A genuine sub-millisecond
timing on a row with a host is left alone. `--hostname NAME` and
`--before 2026-08-20` narrow the set; the command prints the row count and
time span and asks for confirmation (`--yes` skips it). Like the other
backfills it decompresses history chunks first and refreshes the affected
continuous aggregates afterwards, so it may run for minutes on a large
database.

### Large imports and backfills

Bulk operations (`import-logs` over months of archives, either backfill
command on a database with real history) write WAL much faster than live
tailing does. With PostgreSQL's default `max_wal_size` of 1GB the database
checkpoints every few seconds and logs:

```text
LOG:  checkpoints are occurring too frequently (21 seconds apart)
HINT: Consider increasing the configuration parameter "max_wal_size".
```

Nothing is at risk, but each checkpoint re-triggers full-page writes for
the pages the run touches next, so the operation slows down the longer
this goes on. Both settings reload without a restart, so you can raise them
while a backfill is already running:

```bash
docker compose exec timescale_db psql -U geouser -d geometrikks \
  -c "ALTER SYSTEM SET max_wal_size = '4GB';" \
  -c "ALTER SYSTEM SET checkpoint_timeout = '15min';" \
  -c "SELECT pg_reload_conf();"
```

Expect up to `max_wal_size` of extra disk used for WAL during the run, on
top of the temporarily decompressed chunks. To keep the settings
permanently, add `max_wal_size=4GB` and `checkpoint_timeout=15min` to the
database service's `command:` block in the compose file, then run
`ALTER SYSTEM RESET max_wal_size` and `ALTER SYSTEM RESET
checkpoint_timeout` once. Command-line flags override `ALTER SYSTEM`
values, and keeping both means the compose file no longer tells the whole
truth.

## Configuration

`.env.example` covers the short list most installs touch (admin
credentials, MaxMind key, log paths, DB password). For every environment
variable and its default, see
[`docs/configuration.md`](docs/configuration.md).

Set `GEOMETRIKKS_ENV_FILE` to load a different `.env` path, or to an empty
value to disable dotenv loading and configure through real environment
variables only.

### PUID and PGID

The container starts as root only long enough to re-map its internal user
to `PUID`:`PGID` (default `1000:1000`), fix ownership of `/app/logs` and the
GeoIP volume, and drop privileges. The app process never runs as root. Set
`PUID`/`PGID` in `.env` to the user that should own `./logs` on the host
(usually your own: `id -u` / `id -g`).

In an environment that forbids root entirely (rootless Docker, hardened
setups), set a `user:` on the `app` service in the compose file; the
entrypoint detects it, skips the re-mapping, and runs the app as that user.
You then manage `./logs` ownership yourself.

To harden further with PUID/PGID re-mapping:

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

**I'm using Nginx Proxy Manager (or another proxy-manager container). What
log path do I use?**
Point `ACCESS_LOG_DIR` at the host directory where the proxy container
writes its access logs (for Nginx Proxy Manager this is usually its
`data/logs` volume), and set `LOGPARSER_LOG_PATHS` to the specific
access-log file(s) inside it, using the *container* path
(`/var/log/access/...`), not the host path.

**Permission denied reading my log files?**
The app container runs as `PUID`:`PGID` (default 1000:1000), and log mounts
are read-only. Make the log files (and their parent directory) readable by
that uid/gid on the host with `chmod`, `chown` or an ACL entry. Read-only
mounts are intentional: GeoMetrikks never writes to your access logs.

**Does this run on arm64?**
Yes. The GHCR image is a multi-arch manifest for `linux/amd64` and
`linux/arm64`.

**The map is empty.**
Check four things in order: (1) the geo-degraded banner; if it shows,
MaxMind credentials or the GeoLite2 database are missing; (2) that
`LOGPARSER_LOG_PATHS` points at a file receiving traffic in a supported
format (the nginx JSON `log_format` above, the legacy nginx format,
Traefik JSON, or Caddy JSON); (3) that some time has passed since you last
restarted. The map only shows events ingested after startup unless you
have run a batch import. (4) that your proxy logs the visitor's address,
not an upstream proxy or tunnel; Settings > Status shows an advisory when
it does not. See docs/proxy-setup.md.

**What does the "geo-degraded" banner mean?**
The app started without a usable GeoLite2 database: either
`MAXMINDDB_USER_ID`/`MAXMINDDB_LICENSE_KEY` are not set, or the download
has not completed yet. The API and UI stay up, but log ingestion does not
start until a database is available. Add credentials and restart the app
container to clear it. The sidebar's connection indicator also shows
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

`docker-compose.dev.yml` also has a `dev` profile that builds and
hot-reloads the whole stack in Docker via `Dockerfile.dev`, if you would
rather not run the app bare-metal:

```bash
docker compose -f docker-compose.dev.yml --profile dev up --build
```

To inspect the live route animation without generating log traffic, open
the map with the development-only demo harness. It uses fixed worldwide
origins, turns Live mode on, and does not connect to the live-feed
WebSocket:

```text
http://localhost:8000/map?demoTraffic=1       # steady traffic
http://localhost:8000/map?demoTraffic=burst   # overlapping bursts
```

Live routes fly to the home of the source that recorded them (see
[Multi-source setup](#multi-source-setup)); with a single source that is
the app server's own location, discovered at startup through ipify and
looked up in the local GeoLite2 database. `MAP_HOME_LATITUDE` and
`MAP_HOME_LONGITUDE` override that default home, `MAP_HOME_LOCATIONS`
overrides per source, and `MAP_AUTO_DETECT_HOME=false` disables the
outbound lookup. The map's **Route effects** control can also hide the
animation; that preference is kept in browser storage.

### Testing

```bash
uv run pytest                    # unit tests, no docker needed
```

Integration tests need the compose TimescaleDB and are marked
`integration`. When the database is unreachable they are skipped, so the
plain run above stays green.

```bash
docker compose -f docker-compose.dev.yml up -d timescale_db
uv run pytest -m integration     # the real-database suite
```

The integration suite creates a scratch database `geometrikks_it` on the
compose server (migrated to alembic head plus timescale objects) and drops
it at session end; it never touches the `geometrikks` dev database.
Connection overrides: `IT_DB_HOST`, `IT_DB_PORT`, `IT_DB_USER`,
`IT_DB_PASSWORD`.
