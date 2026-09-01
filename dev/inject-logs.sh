#!/bin/bash
# Appends one synthetic nginx line, one traefik JSON line, one
# geometrikks-json line and one caddy-json line per second to nginx_logs/,
# with fresh timestamps and a rotating pool of real public IPs, so the
# agents compose stack (dev/docker-compose.agents.yml) has live traffic to
# ingest.
#
# Runs automatically as the compose stack's log-injector service (for the
# stack's lifetime; `down` stops it). Standalone usage, from the repo root:
#   ./dev/inject-logs.sh &            # runs for 30 minutes, then stops
#   touch dev/inject-logs.stop        # stop it early (also stops the service)
#
# One-shot burst modes for the proxy-peer Status advisory, which needs 500+
# classified lines and would take minutes at the per-second pace. Both
# append geometrikks-json lines to nginx-json.log in one go and exit:
#   ./dev/inject-logs.sh private-burst [N]   # private peer IPs, default 600
#   ./dev/inject-logs.sh cdn-burst [N]       # CDN edge IPs, default 600
#   ./dev/inject-logs.sh public-burst [N]    # default 2000, clears the card
# cdn-burst needs the GeoLite2 ASN database (GEOIP_ASN_ENABLED) and
# LOGPARSER_SEND_LOGS=true: the parser reads the ASN off the access-log row.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOPFILE="$REPO/dev/inject-logs.stop"
# 0 = no time cap, run until stopped (what the compose service sets).
MAX_SECONDS=${INJECT_MAX_SECONDS:-1800}

# nginx_logs/ is gitignored; create the tailed files so the agents find
# them on first start instead of waiting for the first line.
touch "$REPO/nginx_logs/nginx.log" "$REPO/nginx_logs/traefik.log" "$REPO/nginx_logs/nginx-json.log" "$REPO/nginx_logs/caddy.log"

IPS=(8.8.8.8 1.1.1.1 81.2.69.142 91.198.174.192 185.60.216.35 34.71.167.225 104.28.42.7 197.248.21.8 133.242.187.207 200.160.2.3 77.88.55.242 129.226.3.47)
PRIVATE_IPS=(172.18.0.1 172.19.0.4 10.0.0.2 192.168.1.9 100.64.0.7)
# Real edge addresses that resolve to CDN ASNs in GeoLite2 (checked against
# data/geoip on 2026-08-31): Cloudflare-heavy so the card names one provider.
CDN_IPS=(104.16.132.229 104.26.10.78 172.64.155.119 188.114.96.7 104.28.42.7 151.101.1.140 146.75.30.133 23.192.228.80 2.16.241.219)
PATHS=(/ /api/v1/status /login /wp-login.php /assets/app.js /images/logo.png /feed.xml /admin /robots.txt /health)
METHODS=(GET GET GET GET POST GET HEAD GET)
STATUSES=(200 200 200 301 404 200 403 200 500 204)
AGENTS=("Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0" "curl/8.9.1")
REFERRERS=("" "" "https://yourdomain.com/" "https://www.google.com/" "https://duckduckgo.com/" "https://t.co/x8f2kq")
USERS=("" "" "" "" "" "alice" "bob" "svc-backup")

# Sets rt/ut (seconds, three decimals; ut empty when nginx served the
# request itself) and rtms/utms (milliseconds) for one request. Static
# paths never reach an upstream; every 25th dynamic request is a slow
# outlier so the response-time percentiles have a tail.
timings() {
  case "$1" in
    /assets/*|/images/*|/robots.txt|/health)
      rtms=$((RANDOM % 6)); utms=0 ;;
    *)
      if [ $((RANDOM % 25)) -eq 0 ]; then rtms=$((3000 + RANDOM % 5000)); else rtms=$((20 + RANDOM % 2480)); fi
      utms=$((rtms - 1 - RANDOM % 40)); [ "$utms" -lt 1 ] && utms=1 ;;
  esac
  rt=$(printf '%d.%03d' $((rtms / 1000)) $((rtms % 1000)))
  ut=""; [ "$utms" -gt 0 ] && ut=$(printf '%d.%03d' $((utms / 1000)) $((utms % 1000)))
}

# One geometrikks-json line for the IP in $1; the other request fields come
# from the same pools as the per-second loop.
json_line() {
  local ip=$1 path method status agent ref user bytes jts
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  ref=${REFERRERS[$((RANDOM % ${#REFERRERS[@]}))]}
  user=${USERS[$((RANDOM % ${#USERS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  timings "$path"
  jts=$(date +"%Y-%m-%dT%H:%M:%S%:z")
  printf '{"client_ip":"%s","timestamp":"%s","method":"%s","path":"%s","protocol":"HTTP/2.0","status":"%s","bytes":"%s","host":"json.example.com","referrer":"%s","user_agent":"%s","remote_user":"%s","request_time":"%s","upstream_time":"%s","request_raw":"%s %s HTTP/2.0"}\n' \
    "$ip" "$jts" "$method" "$path" "$status" "$bytes" "$ref" "$agent" "$user" "$rt" "$ut" "$method" "$path" >> "$REPO/nginx_logs/nginx-json.log"
}

# One caddy-json line for the IP in $1 (zap defaults: epoch float ts,
# float-second duration, header arrays; optional log_append upstream timing).
caddy_line() {
  local ip=$1 path method status agent ref user bytes cts refh upstreamh
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  ref=${REFERRERS[$((RANDOM % ${#REFERRERS[@]}))]}
  user=${USERS[$((RANDOM % ${#USERS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  timings "$path"
  cts=$(date +%s.%3N)
  refh=""; [ -n "$ref" ] && refh=",\"Referer\":[\"$ref\"]"
  upstreamh=""; [ "$utms" -gt 0 ] && upstreamh=",\"upstream_duration_ms\":$utms"
  printf '{"level":"info","ts":%s,"logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"%s","remote_port":"%s","client_ip":"%s","proto":"HTTP/2.0","method":"%s","host":"caddy.example.com","uri":"%s","headers":{"User-Agent":["%s"]%s}},"bytes_read":0,"user_id":"%s","duration":%s%s,"size":%s,"status":%s,"resp_headers":{"Server":["Caddy"]}}\n' \
    "$cts" "$ip" "$((RANDOM % 50000 + 1024))" "$ip" "$method" "$path" "$agent" "$refh" "$user" "$rt" "$upstreamh" "$bytes" "$status" >> "$REPO/nginx_logs/caddy.log"
}

case "${1:-}" in
  private-burst|cdn-burst|public-burst)
    case "$1" in
      private-burst) pool=("${PRIVATE_IPS[@]}"); n=${2:-600} ;;
      cdn-burst)     pool=("${CDN_IPS[@]}");     n=${2:-600} ;;
      *)             pool=("${IPS[@]}");         n=${2:-2000} ;;
    esac
    for ((b = 0; b < n; b++)); do
      json_line "${pool[$((RANDOM % ${#pool[@]}))]}"
    done
    echo "$1: appended $n lines to nginx_logs/nginx-json.log"
    exit 0 ;;
  '') ;;
  *) echo "unknown mode: $1 (expected private-burst, cdn-burst or public-burst)" >&2; exit 1 ;;
esac

rm -f "$STOPFILE"
trap 'echo "injector stopped by signal after $i iterations"; exit 0' TERM INT

i=0
while [ ! -f "$STOPFILE" ] && { [ "$MAX_SECONDS" -eq 0 ] || [ "$i" -lt "$MAX_SECONDS" ]; }; do
  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  ref=${REFERRERS[$((RANDOM % ${#REFERRERS[@]}))]}
  user=${USERS[$((RANDOM % ${#USERS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  timings "$path"
  nts=$(date +"%d/%b/%Y:%H:%M:%S %z")
  printf '%s - %s [%s]"%s %s HTTP/2.0" %s %s"%s" yourdomain.com "%s""%s" "%s""-" "-"\n' \
    "$ip" "${user:--}" "$nts" "$method" "$path" "$status" "$bytes" "${ref:--}" "$agent" "$rt" "${ut:--}" >> "$REPO/nginx_logs/nginx.log"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  ref=${REFERRERS[$((RANDOM % ${#REFERRERS[@]}))]}
  user=${USERS[$((RANDOM % ${#USERS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  timings "$path"
  # Traefik keeps Referer only when present, so the key is omitted for
  # a direct hit; durations are nanoseconds, OriginStatus is 0 without
  # an upstream.
  tref=""; [ -n "$ref" ] && tref=",\"request_Referer\":\"$ref\""
  dur=$((rtms * 1000000 + RANDOM % 1000 + 500))
  orig=$((utms * 1000000))
  ostat=0; [ "$utms" -gt 0 ] && ostat=$status
  tts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  ttsn=$(date -u +"%Y-%m-%dT%H:%M:%S.%NZ")
  printf '{"ClientAddr":"%s:%s","ClientHost":"%s","ClientPort":"%s","ClientUsername":"%s","DownstreamContentSize":%s,"DownstreamStatus":%s,"Duration":%s,"OriginContentSize":%s,"OriginDuration":%s,"OriginStatus":%s,"Overhead":%s,"RequestAddr":"traefik.example.com","RequestContentSize":0,"RequestCount":%s,"RequestHost":"traefik.example.com","RequestMethod":"%s","RequestPath":"%s","RequestPort":"-","RequestProtocol":"HTTP/2.0","RequestScheme":"https","RetryAttempts":0,"StartLocal":"%s","StartUTC":"%s","TLSCipher":"TLS_AES_128_GCM_SHA256","TLSVersion":"1.3","entryPointName":"https","level":"info","msg":"","request_User-Agent":"%s"%s,"time":"%s"}\n' \
    "$ip" "$((RANDOM % 50000 + 1024))" "$ip" "$((RANDOM % 50000 + 1024))" "${user:--}" "$bytes" "$status" "$dur" "$bytes" "$orig" "$ostat" "$((dur - orig))" "$((i + 1))" "$method" "$path" "$ttsn" "$ttsn" "$agent" "$tref" "$tts" >> "$REPO/nginx_logs/traefik.log"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  json_line "$ip"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  caddy_line "$ip"

  # Every tenth line is one the parser cannot fully use, so the Debug logs
  # page has parse failures to show: a TLS probe on the plain port, a line
  # cut off mid-request by a rotation, and a request with no method. The
  # nginx file gets all three; the JSON file gets the two nginx can express
  # through escape=json (control bytes arrive as \uXXXX, the method is
  # empty). Traefik never writes lines like these. Caddy gets the method-less
  # variant only; it never logs raw probe bytes.
  if [ $((i % 10)) -eq 9 ]; then
    jts=$(date +"%Y-%m-%dT%H:%M:%S%:z")
    case $((RANDOM % 3)) in
      0) printf '%s - - [%s]"\\x16\\x03\\x01\\x02\\x00\\x01\\x00\\x01\\xfc\\x03\\x03" 400 157"-" yourdomain.com "-""0.000" "-""-" "-"\n' "$ip" "$nts" ;;
      1) printf '%s - - [%s]"GET /assets/app\n' "$ip" "$nts" ;;
      2) printf '%s - - [%s]"/ HTTP/1.1" 400 0"-" yourdomain.com "-""0.000" "-""-" "-"\n' "$ip" "$nts" ;;
    esac >> "$REPO/nginx_logs/nginx.log"
    case $((RANDOM % 2)) in
      0) printf '{"client_ip":"%s","timestamp":"%s","method":"","path":"","protocol":"","status":"400","bytes":"157","host":"json.example.com","referrer":"","user_agent":"","remote_user":"","request_time":"0.000","upstream_time":"","request_raw":"\\u0016\\u0003\\u0001\\u0002\\u0000\\u0001\\u0000\\u0001\\u00fc\\u0003\\u0003"}\n' "$ip" "$jts" ;;
      1) printf '{"client_ip":"%s","timestamp":"%s","method":"","path":"/","protocol":"HTTP/1.1","status":"400","bytes":"0","host":"json.example.com","referrer":"","user_agent":"","remote_user":"","request_time":"0.000","upstream_time":"","request_raw":"/ HTTP/1.1"}\n' "$ip" "$jts" ;;
    esac >> "$REPO/nginx_logs/nginx-json.log"
    cts=$(date +%s.%3N)
    printf '{"level":"info","ts":%s,"logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"%s","client_ip":"%s","proto":"","method":"","host":"caddy.example.com","uri":"","headers":{}},"user_id":"","duration":0.0,"size":0,"status":400,"resp_headers":{}}\n' \
      "$cts" "$ip" "$ip" >> "$REPO/nginx_logs/caddy.log"
  fi

  i=$((i + 1))
  sleep 1
done
echo "injector stopped after $i iterations"
