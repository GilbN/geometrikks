import styles from "./Install.module.css";

const quickstart = (
  <>
    <span className="c"># Docker. Images for amd64 and arm64.</span>
    {`
mkdir geometrikks && cd geometrikks
curl -LO https://raw.githubusercontent.com/GilbN/geometrikks/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/GilbN/geometrikks/main/.env.example
$EDITOR .env      `}
    <span className="c"># set APP_ADMIN_PASSWORD, MaxMind key, CARTO key, log path</span>
    {`
docker compose up -d
`}
    <span className="c"># open http://localhost:8000</span>
  </>
);

export function Install() {
  return (
    <section className={styles.install} id="install">
      <div className="wrap">
        <p className="kicker">Install</p>
        <h2 className="section-title">Run GeoMetrikks with Docker Compose.</h2>
        <p className="sub">
          The Compose file starts GeoMetrikks and TimescaleDB on amd64 or arm64. Set the log path and API keys, then
          open the app on port 8000.
        </p>
        <div className={styles.cols}>
          <pre className="block">{quickstart}</pre>
          <ul className={styles.check}>
            <li>
              <b>Docker.</b> The compose file brings TimescaleDB along.
            </li>
            <li>
              <b>A free MaxMind account.</b> GeoLite2 City and ASN download at startup under your key and refresh
              weekly. You never touch .mmdb files.
            </li>
            <li>
              <b>A free CARTO key.</b> The basemap comes from CARTO, and their terms want a key per deployment.
              Optional today; keyless tiles may stop working at any time.
            </li>
            <li>
              <b>A log file, or Loki.</b> Not stdout. Traefik and Caddy need one directive to write a file.
            </li>
            <li>
              <b>One admin password, or OpenID Connect.</b> Single-user login with a password, or through a provider
              such as Authelia, Authentik or Keycloak. Behind a proxy that authenticates every request, you can switch the
              built-in login off.
            </li>
            <li className={styles.no}>
              <b>No CrowdSec needed.</b> Optional. Add a LAPI key later and the Security page lights up.
            </li>
            <li className={styles.no}>
              <b>No telemetry.</b> On its own the server contacts MaxMind for GeoLite2, a public-IP service for the
              map's server location, GitHub for the update check and Spamhaus for the DROP lists. Each one can be
              turned off. <a href="/docs/#outbound-traffic">Outbound traffic</a> has the switches.
            </li>
          </ul>
        </div>
        <p className={styles.links}>
          <a href="/docs/get-started/quickstart/">Quickstart</a>
          <a href="/docs/get-started/geolite2/">GeoLite2 and the CARTO key</a>
          <a href="/docs/sources/proxy-setup/">Behind a CDN or tunnel</a>
        </p>
      </div>
    </section>
  );
}
