import styles from "./Install.module.css";

// The quickstart block is the README's, verbatim.
const readme = "https://github.com/GilbN/geometrikks";

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
              such as Authelia, Authentik or Keycloak. An authenticating proxy or a tailnet can take over instead, and
              the built-in login switches off.
            </li>
            <li className={styles.no}>
              <b>No CrowdSec needed.</b> Optional. Add a LAPI key later and the Security page lights up.
            </li>
            <li className={styles.no}>
              <b>No telemetry.</b> Outbound traffic is the GeoLite2 download and, unless disabled, one public-IP lookup
              for the map's server location.
            </li>
          </ul>
        </div>
        <p className={styles.links}>
          <a href={`${readme}#quickstart`}>Quickstart</a>
          <a href={`${readme}#maxmind-geolite2`}>GeoLite2 and the CARTO key</a>
          <a href={`${readme}#running-behind-a-reverse-proxy`}>Behind a CDN or tunnel</a>
        </p>
      </div>
    </section>
  );
}
