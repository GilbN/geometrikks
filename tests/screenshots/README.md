# Docs screenshots

## CrowdSec fixture facts

The run starts a throwaway CrowdSec LAPI and fills it with alerts for the fixture IPs. A spike against the real image on 2026-11-11 found these facts. `lapi.py` encodes them as constants and payload rules.

- The image is `crowdsecurity/crowdsec:v1.8.1` (`CROWDSEC_IMAGE`).
- The entrypoint exits with code 0 unless `/var/lib/crowdsec/data` is a mount. The container gets an anonymous volume there (`-v /var/lib/crowdsec/data`). `docker rm -f -v` removes the volume along with the container.
- The env holds `DISABLE_ONLINE_API=true`, `DISABLE_AGENT=true`, `NO_HUB_UPGRADE=true` and `BOUNCER_KEY_geometrikks=<key>`. With these set, the container makes no hub download and never registers with the Central API.
- The container runs on `geometrikks-shots-net`, created with `docker network create --internal`. DNS fails inside it, so nothing leaves. No port is published. The host and the app reach the LAPI at the container's own address on that network, `http://<container ip>:8080`.
- The LAPI answers `GET /health` with `{"status":"up"}` about a second after `docker run`. Before that the connection is refused.
- An empty decision list comes back as the JSON literal `null`, not `[]`.
- `cscli machines add <id> --password <pw> -f /dev/null` creates a machine that is already validated. `POST /v1/watchers/login` returns a JWT that lasts one hour.
- The LAPI overwrites `created_at` with the insert time. It keeps `start_at`, `stop_at`, the event timestamps, the `source` geo and ASN fields and the context `meta`. An alert cannot be backdated through `created_at`.
- A decision expires at `stop_at` plus its duration, not at insert time plus duration. A ban that must still be active at capture gets the time the payload is built as its `stop_at`. Its `start_at` can still be days back, at the oldest event.
- A `1s` decision is gone before the first `GET`. The expired bans use `1s` with `stop_at` at their newest event, so they are already expired when the LAPI stores them.
- `remediation: false` reads back as absent.

The alert history list shows `created_at`, so every fixture alert there shows the time the run posted it. The alert detail sheet shows `start_at` and `stop_at` as "First event" and "Last event". The abuse report sorts and dates alerts by `start_at`.

## Documentation visitors

Seed scanners are random addresses inside real hosting ASNs. If one were DROP-listed, a real provider's name would sit next to Spamhaus's description of networks "hijacked or run by spam and cybercrime operations". So no seed IP and no seed ASN goes on a DROP list.

The fixture step writes seven extra scanners instead:

| Address | DROP v4/v6 | Banned |
| --- | --- | --- |
| 203.0.113.10 | 203.0.113.0/24 | |
| 203.0.113.23 | 203.0.113.0/24 | |
| 203.0.113.77 | 203.0.113.0/24 | |
| 198.51.100.14 | 198.51.100.14/32 | yes, and the IP the inspector and abuse report open |
| 198.51.100.200 | none | |
| 2001:db8:d0c::5 | 2001:db8:d0c::5/128 | yes |
| 2001:db8:d0c::9e | none | |

All seven come from the RFC 5737 and RFC 3849 documentation ranges and sit under AS64496 "Fictional Example Hosting", an RFC 5398 documentation ASN. ASN-DROP lists only AS64496, which puts the two addresses on no network list under it. Their user agents leave out CensysInspect, l9scan and masscan, which name a real organization or person.

The DROP feeds also always carry a filler record, 192.0.2.0/24 and 2001:db8:ffff::/48. No visitor uses those, so they match no traffic. `feed_bodies` refuses any network outside the documentation ranges, and the copyright line of every fixture feed reads "GeoMetrikks screenshot fixture, not Spamhaus data". The run checks for that line before it publishes. If it is gone, the app downloaded the real lists.

These visitors have no location. GeoLite2 places none of these addresses, so ingestion would store their requests with no country or city and write no `geo_events` row. The fixture rows do the same. That affects three scenes:

- `drop-networks` lists 203.0.113.0/24 with 3 IPs, 198.51.100.14/32 and 2001:db8:d0c::5/128, each under AS64496. The card has no country column.
- `ip-inspector` opens 198.51.100.14. The header shows the ASN with no flag or city, the locations block is empty, and the map behind the sheet keeps its view, since the address has no marker.
- `abuse-report` for 198.51.100.14 names the network as `AS64496 Fictional Example Hosting` with no country code. Its DROP notice covers both the v4 listing and the ASN-DROP listing.

The seed scanners keep every other CrowdSec fixture: active and expired bans, detections, the captcha and the range ban. Their alerts name probing scenarios only (`crowdsecurity/http-probing`, `http-sensitive-files`, `http-wordpress-scan`, `http-admin-interface-probing`). The captcha and the range ban go through the app's own ban call with the reason "Repeated probing".

The live feeder never emits these visitors. Ingestion skips `2001:db8::/32`, so only the written history holds them.
