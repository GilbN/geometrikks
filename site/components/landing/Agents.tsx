import { siCaddy, siNginx, siTraefikproxy } from "simple-icons";
import styles from "./Agents.module.css";

// APP_MODE=agent: a diagram of three proxies, each with its own agent,
// writing to one database that one full instance serves from.
const sites = [
  { name: "nginx", host: "edge-01", icon: siNginx.path },
  { name: "Traefik", host: "edge-02", icon: siTraefikproxy.path },
  { name: "Caddy", host: "edge-03", icon: siCaddy.path },
];

export function Agents() {
  return (
    <section className={styles.agents} id="agents">
      <div className="wrap">
        <div className={styles.copy}>
          <p className="kicker">Agent mode</p>
          <h2 className="section-title">Several proxies, one map.</h2>
          <p className="sub">
            When traffic comes in through more than one proxy or host, run one full instance plus an agent next to
            each log file. The agent tails, parses, geolocates and writes locally. The full instance runs everything
            else: the UI, the API, migrations, the background jobs and every integration.
          </p>
          <p>
            Every writer publishes committed events over PostgreSQL LISTEN/NOTIFY, so the live map shows a request the
            moment any agent stores it. Each server gets its own beacon on the map, and Access Logs, Geo Logs and the
            map filter by server.
          </p>
          <p>
            An agent needs four things: the mode, database credentials for the shared instance, MaxMind credentials,
            and its log mount. No admin password, no UI, no migrations.
          </p>
          <pre className="block">{`APP_MODE=agent
DB_HOST=timescale.example.internal
LOGPARSER_LOG_PATHS=/var/log/access/access.log
LOGPARSER_SERVER_NAME=edge-01`}</pre>
          <p>LOGPARSER_SERVER_NAME is a name you choose for this server, not nginx's server_name.</p>
          <p>
            You don't need agents if the logs already reach one machine. A single instance tails every shipped file
            and gives each one its own server name, or reads each proxy from Loki with one LogQL selector per proxy.
          </p>
          <a className={styles.more} href="/docs/sources/multiple-sources/">
            Multi-source setup in the docs
          </a>
        </div>
        <div
          className={styles.diagram}
          role="img"
          aria-label="Three proxies, each with an agent, write to one TimescaleDB that one full GeoMetrikks instance serves the UI from"
        >
          <div className={styles.sites}>
            {sites.map((site) => (
              <div key={site.host} className={styles.site}>
                <div className={`${styles.proxy} card`}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d={site.icon} />
                  </svg>
                  <span>{site.name}</span>
                  <span className={`${styles.host} mono`}>{site.host}</span>
                </div>
                <div className={styles.agent}>
                  <span className="mono">APP_MODE=agent</span>
                  <small>tail · parse · geoip · write</small>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.bus} />
          <div className={styles.stem} />
          <div className={`${styles.db} card`}>
            <span>TimescaleDB</span>
            <small>one shared database · LISTEN/NOTIFY</small>
          </div>
          <div className={styles.stem} />
          <div className={`${styles.head} card`}>
            <span>GeoMetrikks</span>
            <small>UI · API · migrations · scheduler · CrowdSec</small>
          </div>
        </div>
      </div>
    </section>
  );
}
