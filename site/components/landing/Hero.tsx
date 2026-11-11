import dots from "@/data/land-dots.json";
import styles from "./Hero.module.css";
import { Terminal } from "./Terminal";

// Headline beside the pipeline terminal, over a faint dot-grid world
// (Natural Earth 110m land, equirectangular, 1000x500).
export function Hero() {
  return (
    <header className={styles.hero}>
      <svg className={styles.dotmap} viewBox="0 0 1000 500" aria-hidden="true">
        {dots.map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r="1.5" />
        ))}
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
            <a className="btn" href="#screens">
              View the map and logs
            </a>
          </div>
          <ul className={styles.facts}>
            <li>MIT</li>
            <li>ghcr.io/gilbn/geometrikks</li>
            <li>amd64 + arm64</li>
            <li>no telemetry</li>
          </ul>
        </div>
        <Terminal />
      </div>
    </header>
  );
}
