# Proxy real-IP setup

GeoMetrikks reads the address your reverse proxy puts in its access log.
If that address belongs to a CDN edge, a tunnel process, or another proxy
in front of yours, the map and analytics key on the wrong address. CDN
traffic pins to the CDN's datacenters. A private address (10.x, 192.168.x,
127.x and similar ranges) gets no location at all. Every proxy in front of
nginx or Traefik needs to be told to log the visitor, not itself. This
guide covers the common setups.

## How to tell

Settings > Status raises one of two advisories when a tailed log's most
recent traffic looks wrong:

- **CDN peer.** Most requests for a host come from a known CDN's ASN. The
  summary names the provider and the share, for example "94% of the last
  2,000 requests for example.com came from Cloudflare addresses." The map
  still fills in, just with the CDN's edge locations instead of your
  visitors'.
- **Private peer.** Most requests come from a private address. The summary
  names the share; the effect is not a wrong location but no location: rows
  with a private peer are dropped before geolocation, so they never reach
  the map or Access logs, even though Settings > Status shows the parser's
  line count climbing.

Both advisories carry a remedy line naming the proxy directive to add and a
link back to this document. `APP_PROXY_ADVISORY=false` turns the checks off.

## nginx

nginx needs the `ngx_http_realip_module` (built in on nearly every
packaged nginx, including the images this project's compose files use).
Three directives, all in the `server` or `http` block that terminates the
connection from the untrusted peer:

```nginx
# One set_real_ip_from per proxy range in front of this nginx.
# Cloudflare's ranges: https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
# ... the rest of Cloudflare's published IPv4 and IPv6 ranges

real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

`real_ip_header` names the header nginx trusts once the peer matches a
`set_real_ip_from` range: `CF-Connecting-IP` behind Cloudflare, or
`X-Forwarded-For` behind anything else that sets it (a load balancer, a
second internal proxy).

```nginx
set_real_ip_from 10.0.0.0/8;
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

`real_ip_recursive` defaults to off, and that default is the trap. With it
off, nginx takes whatever address sits last in the header, full stop, even
if that address is itself another proxy you trust. With two or more hops
between the visitor and this nginx, each one appending to
`X-Forwarded-For`, the last entry is the second-to-last proxy, not the
visitor. Turning it on makes nginx walk the chain from the right and stop
at the first address that is not itself in a `set_real_ip_from` range,
which is the visitor. Set it on whenever more than one hop can occur,
which is most setups behind a CDN plus a container network.

## Cloudflare Tunnel

A Tunnel changes which peer nginx sees. `cloudflared` opens the connection
to your nginx itself, from localhost or a Docker network address, not from
one of Cloudflare's public ranges. `set_real_ip_from` has to cover wherever
`cloudflared` connects from, and the visitor's address only ever shows up
in `CF-Connecting-IP`, never in `X-Forwarded-For`, because `cloudflared` is
the only hop nginx can see:

```nginx
# cloudflared runs on the same host, outside Docker:
set_real_ip_from 127.0.0.1;
# cloudflared runs in its own container on the same Docker network:
# set_real_ip_from 172.20.0.0/16;

real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

Listing Cloudflare's public ranges here does nothing: `cloudflared` is a
local process from nginx's point of view, and those ranges never appear as
its peer address.

## SWAG

[linuxserver SWAG](https://github.com/linuxserver/docker-swag) ships the
realip setup behind a mod rather than inline config. Add
[`swag-cloudflare-real-ip`](https://github.com/linuxserver/docker-mods/tree/swag-cloudflare-real-ip)
to the container:

```env
DOCKER_MODS=linuxserver/mods:swag-cloudflare-real-ip
```

On container start, the mod fetches Cloudflare's current ranges and writes
them to `/config/nginx/cf_real-ip.conf`. Reference that file from SWAG's
`http` block (usually `/config/nginx/nginx.conf`, in a custom include SWAG
loads at startup):

```nginx
real_ip_header X-Forwarded-For;
real_ip_recursive on;
include /config/nginx/cf_real-ip.conf;
```

Behind a Cloudflare Tunnel, add `set_real_ip_from 127.0.0.1;` alongside
those three lines. The mod's ranges file only covers Cloudflare's edge
network, and a Tunnel never connects from it.

## Nginx Proxy Manager

Nginx Proxy Manager has no per-host slot for realip directives, so they go
in a global custom snippet. Create `/data/nginx/custom/http_top.conf` on
the host running NPM (the file loads into the `http` block automatically;
NPM does not need a restart flag, just a restart) with the same lines as
above:

```nginx
set_real_ip_from 173.245.48.0/20;
# ... the rest of your proxy's ranges
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

## Traefik

Traefik strips `X-Forwarded-For` from anything it does not trust. The
chain only shows up in the access log at all once the peer sending it is
listed under the entry point:

```yaml
entryPoints:
  websecure:
    forwardedHeaders:
      trustedIPs:
        - "173.245.48.0/20"
        - "103.21.244.0/22"
```

Never set `forwardedHeaders.insecure`. It trusts the header from any peer,
which means any client can put whatever address it wants in
`X-Forwarded-For` and land it on your map. `trustedIPs` is the only
supported path.

Once the peer is trusted, Traefik logs the chain exactly as it arrived,
and GeoMetrikks takes the rightmost entry, the one your trusted proxy
appended. If you run more than one trusted hop in front of Traefik, each
one appending its own entry, list all of their peer addresses in
`trustedIPs` so Traefik doesn't drop the header from an earlier hop it
doesn't recognize.

## Tailscale-only

If the only thing that ever reaches GeoMetrikks is a Tailscale tailnet,
every peer address is private by design and the private-peer advisory is
not telling you anything is wrong. Set:

```env
APP_PROXY_ADVISORY=false
```

## What this is not

`APP_TRUSTED_PROXIES` is a separate setting for a separate problem. It
controls how the app itself resolves the client address on its own
inbound requests, the ones logged for login auditing (`lib/client_ip.py`).
It has no effect on how the log parser reads your proxy's access log
files; that path is governed entirely by what your proxy chooses to write,
which is what the rest of this document covers.

## History

None of this is retroactive. Rows already ingested keep whatever address
was in the log line at the time; there is no backfill for a real-IP fix
made after the fact. Rows dropped as private peers were never stored in
the first place, so there is nothing to recover for them either. Fix the
proxy config, and correct addresses start from the next line it writes.

## Limits

- A source tailed by an agent instance (`APP_MODE=agent`) reports its
  advisories on that agent's own `/health` and in its own logs, not on the
  head's Settings > Status page.
- CDN detection needs the GeoLite2 ASN database. Without it, every peer
  classifies as "other" or "private," and CDN traffic never raises the
  advisory even at 100% share.
- Both detectors need at least 500 lines in the rolling 2,000-line window
  before they can trigger, and only fire once the CDN or private share
  crosses 70% of that window. A source with light or mixed traffic can sit
  below that floor indefinitely without an advisory, even if some fraction
  of its traffic is affected.
- Installs running with `LOGPARSER_SEND_LOGS=false` get private-peer
  detection only. CDN classification reads the ASN attached to the parsed
  access-log row, and that row does not exist in geo-only mode.
