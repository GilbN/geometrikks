import { siCaddy, siGrafana, siNginx, siNginxproxymanager, siTraefikproxy } from "simple-icons";
import styles from "./Hero.module.css";
import { Terminal } from "./Terminal";

const sources = [
  { name: "nginx", icon: siNginx.path },
  { name: "Nginx Proxy Manager", icon: siNginxproxymanager.path },
  { name: "Traefik", icon: siTraefikproxy.path },
  { name: "Caddy", icon: siCaddy.path },
  { name: "Loki", icon: siGrafana.path },
];

// Headline beside the pipeline terminal, over a faint dot-grid world
// (Natural Earth 110m land, equirectangular, 1000x500). The dots live in
// public/land-dots.svg, written by scripts/prepare.ts, so they stay out of the HTML.
export function Hero() {
  return (
    <header className={styles.hero}>
      <svg className={styles.dotmap} viewBox="0 0 1000 500" aria-hidden="true">
        <use href="/land-dots.svg#d" />
      </svg>
      <div className="wrap">
        <div className="copy">
          <h1>
            Your access logs, <em>on a live map.</em>
          </h1>
          <p className={styles.lede}>
            GeoMetrikks tails your reverse proxy's access log, looks every request up in GeoLite2, and draws it on a
            world map within seconds. Traffic analytics, a searchable history, and CrowdSec bans next to the traffic
            that caused them. On your own hardware.
          </p>
          <div className={styles.cta}>
            <a className="btn primary" href="#install">
              Install with Docker
            </a>
            <a className="btn" href="/docs/">
              Read the docs
            </a>
          </div>
          <a
            className={styles.reads}
            href="#sources"
            aria-label={`Log sources: ${sources.map((source) => source.name).join(", ")}`}
          >
            <ul>
              {sources.map((source) => (
                <li key={source.name}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d={source.icon} />
                  </svg>
                  {source.name}
                </li>
              ))}
            </ul>
          </a>
          <p className={styles.facts}>MIT licensed. One Docker image for amd64 and arm64. No telemetry.</p>
        </div>
        <Terminal />
      </div>
    </header>
  );
}
