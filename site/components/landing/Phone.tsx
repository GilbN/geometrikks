import screenshots from "@/.generated/screenshots.json";
import { type Manifest, sceneEntry, shotSrc, variant } from "@/lib/screenshots";
import { ZoomHint } from "../ShotPair";
import styles from "./Phone.module.css";

const shots = [
  { scene: "map", label: "Location details", note: "Tap a marker for its counts and top IPs." },
  { scene: "satellite", label: "Satellite", note: "The map over Esri imagery, with an Esri key." },
  { scene: "access-logs", label: "Access logs", note: "Every request with its status, URL and client IP." },
  { scene: "filter-drawer", label: "Filters", note: "Filters open in a drawer, one row each." },
  { scene: "ip-inspector", label: "IP inspector", note: "One address and what it asked for." },
].map((shot) => {
  const entry = sceneEntry(screenshots as Manifest, shot.scene);
  const image = variant(entry, "phone", "dark");
  if (!image) throw new Error(`screenshot scene ${shot.scene} has no phone-dark variant`);
  return { ...shot, alt: entry.alt, src: shotSrc(image), width: image.width, height: image.height };
});

export function Phone() {
  return (
    <section className={styles.phone} id="phone">
      <div className="wrap">
        <h2 className="section-title">Install it on your phone.</h2>
        <p className="sub">
          GeoMetrikks is a progressive web app with a phone layout for every page. Serve it over HTTPS, add it to your
          home screen, and it opens like an installed app, without the browser's toolbar.
        </p>
      </div>
      <ul className={styles.row}>
        {shots.map((shot) => (
          <li key={shot.scene}>
            <a
              className="zoom"
              href={shot.src}
              data-zoom=""
              data-zoom-alt={shot.alt}
              data-zoom-caption={`${shot.label}. ${shot.note}`}
              aria-label={`View the ${shot.label} phone screenshot larger`}
            >
              <img src={shot.src} width={shot.width} height={shot.height} alt={shot.alt} loading="lazy" decoding="async" />
              <ZoomHint />
            </a>
            <h3>{shot.label}</h3>
            <p>{shot.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
