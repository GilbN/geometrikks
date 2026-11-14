import type { CSSProperties } from "react";
import {
  siCarto,
  siEsri,
  siMaplibre,
  siPostgresql,
  siPython,
  siReact,
  siShadcnui,
  siTailwindcss,
  siTanstack,
  siTimescale,
  siVite,
} from "simple-icons";
import styles from "./BuiltWith.module.css";
import { LitestarLogo } from "./logos";

// The larger pieces GeoMetrikks is built on. Icons are simple-icons (CC0)
// except Litestar, whose mark and gold come from litestar-org/branding (MIT).
const items = [
  { name: "Litestar", role: "Python API, WebSockets, CLI", href: "https://litestar.dev", icon: null, brand: "EDB641" },
  { name: "Python", role: "3.13, uv, asyncio", href: "https://www.python.org", icon: siPython },
  { name: "TimescaleDB", role: "hypertables and continuous aggregates", href: "https://www.timescale.com", icon: siTimescale },
  { name: "PostgreSQL + PostGIS", role: "geometry types and spatial queries", href: "https://postgis.net", icon: siPostgresql },
  { name: "React", role: "the single-page UI", href: "https://react.dev", icon: siReact },
  { name: "Vite", role: "build and dev server", href: "https://vite.dev", icon: siVite },
  { name: "TanStack", role: "Router and Query", href: "https://tanstack.com", icon: siTanstack },
  { name: "shadcn/ui", role: "components on Base UI", href: "https://ui.shadcn.com", icon: siShadcnui },
  { name: "Tailwind CSS", role: "styling", href: "https://tailwindcss.com", icon: siTailwindcss },
  { name: "MapLibre GL JS", role: "the map, flat and globe", href: "https://maplibre.org", icon: siMaplibre },
  { name: "CARTO", role: "basemap tiles on OpenStreetMap data", href: "https://carto.com/basemaps", icon: siCarto },
  { name: "Esri", role: "World Imagery for the Satellite view", href: "https://www.esri.com", icon: siEsri },
];

export function BuiltWith() {
  return (
    <section className={styles.built} id="built-with">
      <div className="wrap">
        <h2 className="section-title">What it runs on.</h2>
        <div className={styles.grid}>
          {items.map((item) => (
            <a
              key={item.name}
              className={`${styles.item} card`}
              href={item.href}
              rel="noopener"
              style={{ "--brand": `#${item.icon ? item.icon.hex : item.brand}` } as CSSProperties}
            >
              {item.icon ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={item.icon.path} />
                </svg>
              ) : (
                <LitestarLogo className="mark" width={28} height={28} aria-hidden="true" />
              )}
              <span className={styles.name}>{item.name}</span>
              <span className={styles.role}>{item.role}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
