import styles from "./Install.module.css";

const quickstart = (
  <>
    {`mkdir geometrikks && cd geometrikks
curl -LO https://raw.githubusercontent.com/GilbN/geometrikks/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/GilbN/geometrikks/main/.env.example
$EDITOR .env      `}
    <span className="c"># set APP_ADMIN_PASSWORD, DB_PASSWORD and the MaxMind and CARTO keys</span>
    {`
                  `}
    <span className="c"># add ACCESS_LOG_DIR, the folder your proxy writes its logs to</span>
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
        <h2 className="section-title">Run GeoMetrikks with Docker Compose.</h2>
        <p className="sub">
          The Compose file starts GeoMetrikks and TimescaleDB on amd64 or arm64. Set the log path and your keys, then
          open the app on port 8000.
        </p>
        <pre className="block">{quickstart}</pre>
        <div className={styles.cols}>
          <div>
            <h3>You need</h3>
            <ul>
              <li>
                <b>Docker.</b> The Compose file brings TimescaleDB along.
              </li>
              <li>
                <b>A free MaxMind account.</b> GeoLite2 City and ASN download at startup under your key and refresh
                weekly. You never touch .mmdb files.
              </li>
              <li>
                <b>A free CARTO key.</b> The basemap comes from CARTO, and their terms want a key per deployment. The
                map loads without one today, but CARTO may refuse keyless tiles at any time.
              </li>
              <li>
                <b>A log file, or Loki.</b> Not stdout. Traefik and Caddy need one directive to write a file.
              </li>
              <li>
                <b>An admin password, or OpenID Connect.</b> Behind a proxy that authenticates every request, you can
                switch the built-in login off.
              </li>
            </ul>
          </div>
          <div>
            <h3>Optional</h3>
            <ul>
              <li>
                <b>A free Esri key.</b> For the map's Satellite view, which draws Esri World Imagery.
              </li>
              <li>
                <b>CrowdSec.</b> Add a Local API key later and the Security page fills in.
              </li>
              <li>
                <b>An AbuseIPDB key.</b> For scores in the IP inspector, reporting and the blacklist.
              </li>
            </ul>
          </div>
        </div>
        <p className={styles.note}>
          <b>No telemetry.</b> On its own the server contacts MaxMind for GeoLite2, a public-IP service for the map's
          server location, GitHub for the update check and Spamhaus for the DROP lists. Each one can be turned off.{" "}
          <a className="more" href="/docs/#outbound-traffic">
            Outbound traffic
          </a> lists every request and its switch.
        </p>
        <p className={styles.links}>
          <a href="/docs/get-started/quickstart/">Quickstart</a>
          <a href="/docs/get-started/geolite2/">GeoLite2 and the CARTO key</a>
          <a href="/docs/sources/proxy-setup/">Behind a CDN or tunnel</a>
          <a href="/docs/get-started/upgrading/">Upgrading</a>
        </p>
      </div>
    </section>
  );
}
