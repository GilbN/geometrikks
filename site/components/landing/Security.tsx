import screenshots from "@/.generated/screenshots.json";
import { type Manifest, sceneEntry, shotSrc, variant } from "@/lib/screenshots";
import { ZoomHint } from "../ShotPair";
import { CrowdSecLogo } from "./logos";
import styles from "./Security.module.css";

// The inspector picture is the screenshot cropped to its right edge, where the
// sheet with the ban badge sits; the zoom link opens the whole thing.
function desktopDark(id: string) {
  const entry = sceneEntry(screenshots as Manifest, id);
  const shot = variant(entry, "desktop", "dark");
  if (!shot) throw new Error(`screenshot scene ${id} has no desktop-dark variant`);
  return { src: shotSrc(shot), width: shot.width, height: shot.height, alt: entry.alt };
}

const inspector = desktopDark("ip-inspector");
const bannedMap = desktopDark("banned-map");

const connect = (
  <>
    <span className="c"># prints the API key</span>
    {`
docker exec crowdsec cscli bouncers add geometrikks

CROWDSEC_LAPI_URL=http://crowdsec:8080
CROWDSEC_BOUNCER_API_KEY=<key>`}
  </>
);

const signals = [
  {
    title: "Spamhaus DROP lists",
    body: "GeoMetrikks downloads the DROP lists and marks traffic from the networks on them. With CrowdSec machine credentials, the DROP tab bans a whole network.",
    href: "/docs/features/drop-lists/",
  },
  {
    title: "AbuseIPDB",
    body: "Add a key and the IP inspector shows an address's AbuseIPDB score. Turn on reporting to report an IP from its actions menu, and the blacklist to mark the IPs on it.",
    href: "/docs/features/abuseipdb/",
  },
  {
    title: "Abuse reports",
    body: "Build a report about one IP or the busiest IPs of a network, look up the network's abuse contact, and copy or download it. The report leaves out your server names and hosts. Read it through before you send it.",
    href: "/docs/features/abuse-reports/",
  },
];

export function Security() {
  return (
    <section className={styles.security} id="security">
      <div className="wrap">
        <p className={styles.lockup}>
          <CrowdSecLogo width={22} height={22} aria-hidden="true" /> With CrowdSec
        </p>
        <h2 className="section-title">Watch hostile traffic fuck around and find out.</h2>
        <p className="sub">
          Connect the Local API and the map's Banned IPs view shows where the bans come from. Open any of them in the
          IP inspector to see what that address did to earn it.
        </p>
        <a
          className={`zoom ${styles.map}`}
          href={bannedMap.src}
          data-zoom=""
          data-zoom-alt={bannedMap.alt}
          data-zoom-caption="Banned IPs map view. Each marker counts the banned addresses seen at that location in the selected range."
          aria-label="View the Banned IPs map larger"
        >
          <img
            src={bannedMap.src}
            width={bannedMap.width}
            height={bannedMap.height}
            alt={bannedMap.alt}
            loading="lazy"
            decoding="async"
          />
          <ZoomHint />
        </a>
        <div className={styles.detail}>
          <a
            className={`zoom ${styles.shot}`}
            href={inspector.src}
            data-zoom=""
            data-zoom-alt={inspector.alt}
            data-zoom-caption="IP inspector over the map for a banned address, with its DROP and AbuseIPDB blacklist marks and its AbuseIPDB score."
            aria-label="View the IP inspector larger"
          >
            <img
              src={inspector.src}
              width={inspector.width}
              height={inspector.height}
              alt={inspector.alt}
              loading="lazy"
              decoding="async"
            />
            <ZoomHint />
          </a>
          <dl>
            <div>
              <dt>Every ban with the traffic behind it</dt>
              <dd>
                The IP inspector shows an address's request counts, bandwidth, response codes over time, hosts, paths,
                user agents and recent requests, with its CrowdSec decision and how long is left on it. Requests that
                arrive after the ban are called out.
              </dd>
            </div>
            <div>
              <dt>Ban and unban from the UI</dt>
              <dd>
                With machine credentials, the IP actions menu in the tables gets Ban and Unban, and a shield button
                beside the IP does the same in map popups and the IP inspector. Pick a preset from an hour to forever,
                or type your own duration. Every ban and unban is audit-logged with the acting user.
              </dd>
            </div>
            <div>
              <dt>Ban changes appear within seconds</dt>
              <dd>
                GeoMetrikks follows CrowdSec's live updates, including bans and unbans made outside GeoMetrikks. The
                map and the badges refresh together.
              </dd>
            </div>
            <div>
              <dt>Two lines to connect</dt>
              <dd>
                <pre className="block">{connect}</pre>
                CrowdSec decides; a bouncer in front of your stack still does the blocking. GeoMetrikks shows and
                manages decisions, it does not block traffic.{" "}
                <a href="/docs/features/crowdsec/">CrowdSec setup in the docs</a>
              </dd>
            </div>
          </dl>
        </div>
        <h3 className={styles.also}>With or without CrowdSec</h3>
        <ul className={styles.signals}>
          {signals.map((signal) => (
            <li key={signal.title}>
              <a href={signal.href}>
                <b>{signal.title}</b>
                <span>{signal.body}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
