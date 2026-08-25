#!/bin/bash
# Appends one synthetic nginx line, one traefik JSON line and one
# geometrikks-json line per second to nginx_logs/, with fresh timestamps
# and a rotating pool of real public IPs, so the agents compose stack
# (dev/docker-compose.agents.yml) has live traffic to ingest.
#
# Runs automatically as the compose stack's log-injector service (for the
# stack's lifetime; `down` stops it). Standalone usage, from the repo root:
#   ./dev/inject-logs.sh &            # runs for 30 minutes, then stops
#   touch dev/inject-logs.stop        # stop it early (also stops the service)
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOPFILE="$REPO/dev/inject-logs.stop"
# 0 = no time cap, run until stopped (what the compose service sets).
MAX_SECONDS=${INJECT_MAX_SECONDS:-1800}

rm -f "$STOPFILE"
# nginx_logs/ is gitignored; create the tailed files so the agents find
# them on first start instead of waiting for the first line.
touch "$REPO/nginx_logs/nginx.log" "$REPO/nginx_logs/traefik.log" "$REPO/nginx_logs/nginx-json.log"
trap 'echo "injector stopped by signal after $i iterations"; exit 0' TERM INT

IPS=(8.8.8.8 1.1.1.1 81.2.69.142 91.198.174.192 185.60.216.35 34.71.167.225 104.28.42.7 197.248.21.8 133.242.187.207 200.160.2.3 77.88.55.242 129.226.3.47)
PATHS=(/ /api/v1/status /login /wp-login.php /assets/app.js /images/logo.png /feed.xml /admin /robots.txt /health)
METHODS=(GET GET GET GET POST GET HEAD GET)
STATUSES=(200 200 200 301 404 200 403 200 500 204)
AGENTS=("Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0" "curl/8.9.1")

i=0
while [ ! -f "$STOPFILE" ] && { [ "$MAX_SECONDS" -eq 0 ] || [ "$i" -lt "$MAX_SECONDS" ]; }; do
  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  nts=$(date +"%d/%b/%Y:%H:%M:%S %z")
  printf '%s - - [%s]"%s %s HTTP/2.0" %s %s"-" yourdomain.com "-""0.0%02d" "0.001""-" "-"\n' \
    "$ip" "$nts" "$method" "$path" "$status" "$bytes" "$((RANDOM % 90))" >> "$REPO/nginx_logs/nginx.log"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  tts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  ttsn=$(date -u +"%Y-%m-%dT%H:%M:%S.%NZ")
  printf '{"ClientAddr":"%s:%s","ClientHost":"%s","ClientPort":"%s","ClientUsername":"-","DownstreamContentSize":%s,"DownstreamStatus":%s,"Duration":%s,"OriginContentSize":%s,"OriginDuration":0,"OriginStatus":%s,"Overhead":1200,"RequestAddr":"traefik.example.com","RequestContentSize":0,"RequestCount":%s,"RequestHost":"traefik.example.com","RequestMethod":"%s","RequestPath":"%s","RequestPort":"-","RequestProtocol":"HTTP/2.0","RequestScheme":"https","RetryAttempts":0,"StartLocal":"%s","StartUTC":"%s","TLSCipher":"TLS_AES_128_GCM_SHA256","TLSVersion":"1.3","entryPointName":"https","level":"info","msg":"","request_User-Agent":"%s","time":"%s"}\n' \
    "$ip" "$((RANDOM % 50000 + 1024))" "$ip" "$((RANDOM % 50000 + 1024))" "$bytes" "$status" "$((RANDOM % 90000 + 500))" "$bytes" "$status" "$((i + 1))" "$method" "$path" "$ttsn" "$ttsn" "$agent" "$tts" >> "$REPO/nginx_logs/traefik.log"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  jts=$(date +"%Y-%m-%dT%H:%M:%S%:z")
  printf '{"client_ip":"%s","timestamp":"%s","method":"%s","path":"%s","protocol":"HTTP/2.0","status":"%s","bytes":"%s","host":"json.example.com","referrer":"","user_agent":"%s","remote_user":"","request_time":"0.0%02d","upstream_time":"0.001","request_raw":"%s %s HTTP/2.0"}\n' \
    "$ip" "$jts" "$method" "$path" "$status" "$bytes" "$agent" "$((RANDOM % 90))" "$method" "$path" >> "$REPO/nginx_logs/nginx-json.log"

  # Every tenth line is one the parser cannot fully use, so the Debug logs
  # page has parse failures to show: a TLS probe on the plain port, a line
  # cut off mid-request by a rotation, and a request with no method. The
  # nginx file gets all three; the JSON file gets the two nginx can express
  # through escape=json (control bytes arrive as \uXXXX, the method is
  # empty). Traefik never writes lines like these.
  if [ $((i % 10)) -eq 9 ]; then
    case $((RANDOM % 3)) in
      0) printf '%s - - [%s]"\\x16\\x03\\x01\\x02\\x00\\x01\\x00\\x01\\xfc\\x03\\x03" 400 157"-" yourdomain.com "-""0.000" "-""-" "-"\n' "$ip" "$nts" ;;
      1) printf '%s - - [%s]"GET /assets/app\n' "$ip" "$nts" ;;
      2) printf '%s - - [%s]"/ HTTP/1.1" 400 0"-" yourdomain.com "-""0.000" "-""-" "-"\n' "$ip" "$nts" ;;
    esac >> "$REPO/nginx_logs/nginx.log"
    case $((RANDOM % 2)) in
      0) printf '{"client_ip":"%s","timestamp":"%s","method":"","path":"","protocol":"","status":"400","bytes":"157","host":"json.example.com","referrer":"","user_agent":"","remote_user":"","request_time":"0.000","upstream_time":"","request_raw":"\\u0016\\u0003\\u0001\\u0002\\u0000\\u0001\\u0000\\u0001\\u00fc\\u0003\\u0003"}\n' "$ip" "$jts" ;;
      1) printf '{"client_ip":"%s","timestamp":"%s","method":"","path":"/","protocol":"HTTP/1.1","status":"400","bytes":"0","host":"json.example.com","referrer":"","user_agent":"","remote_user":"","request_time":"0.000","upstream_time":"","request_raw":"/ HTTP/1.1"}\n' "$ip" "$jts" ;;
    esac >> "$REPO/nginx_logs/nginx-json.log"
  fi

  i=$((i + 1))
  sleep 1
done
echo "injector stopped after $i iterations"
