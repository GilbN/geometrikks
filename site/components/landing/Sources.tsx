"use client";

import { siCaddy, siGrafana, siNginx, siNginxproxymanager, siTraefikproxy } from "simple-icons";
import styles from "./Sources.module.css";
import { useTabs } from "./useTabs";

// One tab per source: the log config it needs, the two .env lines,
// and the traps. Snippets mirror the README sections the docs are built from.
const readme = "https://github.com/GilbN/geometrikks";

const proxies = [
  {
    id: "nginx",
    name: "nginx",
    icon: siNginx.path,
    formats: ["geometrikks-json", "nginx", "combined"],
    file: "nginx.conf",
    snippet: `log_format geometrikks_json escape=json
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

access_log /config/log/nginx/access.log geometrikks_json;`,
    env: ["ACCESS_LOG_DIR=/var/log/nginx", "LOGPARSER_LOG_PATHS=/var/log/access/access.log"],
    notes: [
      "nginx 1.11.8 or later, for escape=json.",
      "The older positional format and nginx's built-in combined parse too, so archives import without a config change.",
      "Behind a CDN, set real_ip so $remote_addr is the visitor and not the CDN.",
    ],
    docs: `${readme}#nginx-setup`,
  },
  {
    id: "npm",
    name: "Nginx Proxy Manager",
    icon: siNginxproxymanager.path,
    formats: ["geometrikks-json", "npm"],
    file: "/data/nginx/custom/",
    snippet: `# http_top.conf
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

# server_proxy.conf
access_log /data/logs/geometrikks_access.log geometrikks_json;`,
    env: ["ACCESS_LOG_DIR=/path/to/npm/data/logs", "LOGPARSER_LOG_PATHS=/var/log/access/geometrikks_access.log"],
    notes: [
      "NPM's own per-host logs have no request times, so GeoMetrikks only imports them. The second log is the live one.",
      "Every proxy host writes to the one file. The host filter tells them apart.",
      "Hosts with Cache Assets on never log CSS, JS, images or fonts, so GeoMetrikks never sees them.",
    ],
    docs: `${readme}#nginx-proxy-manager-setup`,
  },
  {
    id: "traefik",
    name: "Traefik",
    icon: siTraefikproxy.path,
    formats: ["traefik-json"],
    file: "traefik.yml",
    snippet: `accessLog:
  filePath: "/var/log/traefik/access.log"
  format: json
  fields:
    headers:
      names:
        User-Agent: keep
        Referer: keep`,
    env: ["ACCESS_LOG_DIR=/var/log/traefik", "LOGPARSER_LOG_PATHS=/var/log/access/access.log"],
    notes: [
      "A file path is required. Traefik logs to stdout by default, and GeoMetrikks cannot read that.",
      "Rotate with logrotate, then docker kill --signal=USR1 traefik. GeoMetrikks follows the rotation.",
      "Behind a CDN, set forwardedHeaders.trustedIPs on the entry point. Never forwardedHeaders.insecure.",
    ],
    docs: `${readme}#traefik-setup`,
  },
  {
    id: "caddy",
    name: "Caddy",
    icon: siCaddy.path,
    formats: ["caddy-json"],
    file: "Caddyfile",
    snippet: `(log_settings) {
  log {
    output file /var/log/caddy/access.log
    format json
    level INFO
  }
  log_append upstream_duration_ms {rp.upstream.duration_ms}
}

app.example.com {
  import log_settings
  reverse_proxy app:8000
}`,
    env: ["ACCESS_LOG_DIR=/var/log/caddy", "LOGPARSER_LOG_PATHS=/var/log/access/access.log"],
    notes: [
      "Caddy logs to stderr by default. The log directive writes the file.",
      "The log_append line fills the upstream response time column. Without it the column shows a dash.",
      "Behind a CDN, set trusted_proxies in the global options so client_ip is the visitor.",
    ],
    docs: `${readme}#caddy-setup`,
  },
  {
    id: "loki",
    name: "Loki",
    icon: siGrafana.path,
    formats: ["geometrikks-json", "nginx", "traefik-json", "caddy-json"],
    file: "config.alloy",
    snippet: `loki.source.file "traefik" {
  targets = [{
    __path__     = "/var/log/traefik/access.log",
    job          = "traefik",
    service_name = "traefik",
  }]
  tail_from_end = true
  forward_to    = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}`,
    env: ["LOKI_URL=http://loki:3100", 'LOKI_QUERIES={job="traefik"}'],
    notes: [
      "Loki has to hold the raw access-log line. A pipeline stage that rewrites it, into logfmt for example, leaves nothing to parse.",
      "One LogQL selector per log format. LOKI_SERVER_NAMES gives each selector its own server name.",
      "Reading starts when the app starts. Lines logged while it was down are not read.",
    ],
    docs: `${readme}#loki-setup`,
  },
];


export function Sources() {
  const { tabProps, panelProps } = useTabs(proxies.length);
  return (
    <section className="sources" id="sources">
      <div className="wrap">
        <p className="kicker">Sources</p>
        <h2 className="section-title">Point it at the log your proxy already writes.</h2>
        <p className="sub">
          The format is detected per file. Rotated files are followed. If a shipper already sends the lines to Loki,
          read them from there. Archives, plain or gzipped, can be backfilled through the same pipeline with one
          command.
        </p>
        <div className="tabs" role="tablist" aria-label="Log source">
          {proxies.map((proxy, index) => (
            <button key={proxy.id} id={`tab-${proxy.id}`} aria-controls={`panel-${proxy.id}`} {...tabProps(index)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={proxy.icon} />
              </svg>
              {proxy.name}
            </button>
          ))}
        </div>
        {proxies.map((proxy, index) => (
          <div
            key={proxy.id}
            className={`${styles.panel} card`}
            id={`panel-${proxy.id}`}
            aria-labelledby={`tab-${proxy.id}`}
            {...panelProps(index)}
          >
            <div className="conf">
              <div className={styles.head}>
                <span className={`${styles.file} mono`}>{proxy.file}</span>
                <span className={styles.formats}>
                  {proxy.formats.map((format) => (
                    <code key={format}>{format}</code>
                  ))}
                </span>
              </div>
              <pre className="block">{proxy.snippet}</pre>
            </div>
            <div className={styles.side}>
              <h3>In .env</h3>
              <pre className={`block ${styles.env}`}>{proxy.env.join("\n")}</pre>
              <h3>Worth knowing</h3>
              <ul>
                {proxy.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <a className={styles.more} href={proxy.docs}>
                {proxy.name} setup in the docs
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
