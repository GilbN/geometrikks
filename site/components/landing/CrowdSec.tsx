import screenshots from "@/.generated/screenshots.json";
import { type Manifest, sceneEntry, shotSrc, variant } from "@/lib/screenshots";
import { ZoomHint } from "../ShotPair";
import { CrowdSecLogo } from "./logos";
import styles from "./CrowdSec.module.css";

// CrowdSec gets its own section: the Banned IPs map view across the top,
// then the IP inspector beside the copy and the two-line setup. The inspector
// picture is the screenshot cropped to its right edge, where the sheet with
// the ban badge sits; the zoom link opens the whole thing.
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

export function CrowdSec() {
  return (
    <section className={styles.crowdsec} id="crowdsec">
      <div className="wrap">
        <p className={`kicker ${styles.kicker}`}>
          <CrowdSecLogo width={22} height={22} aria-hidden="true" /> CrowdSec
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
            data-zoom-caption="IP inspector over the map for a banned address."
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
                beside the IP does the same in map popups and the IP inspector. Pick a preset from an hour to forever, or type
                your own duration. Every
                ban and unban is audit-logged with the acting user.
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
      </div>
    </section>
  );
}
