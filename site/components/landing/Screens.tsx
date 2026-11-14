"use client";

import { useEffect, useRef } from "react";
import screenshots from "@/.generated/screenshots.json";
import styles from "./Screens.module.css";
import { useTabs } from "./useTabs";

// One screenshot at a time behind a tab strip. All panels render; the
// component only toggles hidden and starts or stops the map clip. Screenshots
// come from data/screenshots via prepare.ts; the clip lives in public/media.
type Screen = { id: string; label: string; img: string; cap: string; alt: string; video?: string; path?: string };

const sizes: Record<string, { width: number; height: number }> = screenshots;

function shot(file: string) {
  const name = file.replace(/\.png$/, "");
  const size = sizes[name];
  if (!size) throw new Error(`Missing screenshot ${file}; run scripts/prepare.ts`);
  return { src: `/screenshots/${name}.webp`, ...size };
}

const screens: Screen[] = [
  { id: "map", label: "Map", img: "live.png", video: "/media/map", cap: "Live map. Show requests as markers, clusters or a heatmap on a flat map or globe, over a street map or satellite imagery. Switch to the Banned IPs view to see where CrowdSec bans come from. Live routes end at the server location you configure.", alt: "The live map with marker clusters, a live request feed, a live route to the server location, and map controls offering the Heatmap, Markers and Banned views" },
  { id: "overview", label: "Overview", img: "dashboard.png", cap: "Overview. Requests, visitors, bandwidth and errors for the chosen time period, compared with the previous period.", alt: "Overview dashboard with summary cards and trend charts" },
  { id: "analytics", label: "Analytics", img: "analytics.png", cap: "Analytics. Request volume, response codes, latency percentiles, bandwidth, top URLs by host, user agents and ASNs.", alt: "Analytics page with request, status, bandwidth and latency charts" },
  { id: "access-logs", label: "Access logs", img: "access-logs.png", cap: "Access logs. Search every request and filter by status, method, IP, host, country or server.", alt: "Access logs table with filters and a selected request" },
  { id: "geo-logs", label: "Geo logs", img: "geo-logs.png", cap: "Geo logs. Traffic grouped by place: which locations send requests and how that changes over time.", alt: "Geo logs table grouped by country and city" },
  { id: "ip-inspector", label: "IP inspector", img: "ip-inspector.png", cap: "IP inspector. Select an address to see request counts, bandwidth, response codes over time, hosts, paths, user agents, recent requests and CrowdSec status. You can ban it here too.", alt: "IP inspector open over the map for a banned address, with request counts, targets, paths, user agents and recent requests" },
  { id: "security", label: "Security", img: "crowdsec.png", cap: "Security. CrowdSec bans shown with matching requests from your logs.", alt: "Security page listing active CrowdSec bans" },
  { id: "debug-logs", label: "Debug logs", img: "debug-logs.png", cap: "Debug logs. The raw source lines behind every request, with parse failures called out.", alt: "Debug logs page showing raw log lines and parse failures" },
  { id: "status", label: "Status", path: "settings/status", img: "status.png", cap: "Status. Ingestion, database, GeoIP and CrowdSec health on one page, with every log file and Loki selector listed. Advisories flag what needs attention, such as a missing ASN database or a server whose location could not be detected.", alt: "Settings Status page with ingestion running from two log files and a Loki selector, the database, GeoIP and CrowdSec cards" },
];

export function Screens() {
  const { tabProps, panelProps } = useTabs(screens.length);
  const video = useRef<HTMLVideoElement>(null);

  // The clip plays only while its panel is on screen, and never under
  // reduced motion, where the poster stands in for it.
  useEffect(() => {
    const clip = video.current;
    if (!clip || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? clip.play().catch(() => {}) : clip.pause()),
      { threshold: 0.25 },
    );
    observer.observe(clip);
    return () => observer.disconnect();
  }, []);

  return (
    <section className={styles.screens} id="screens">
      <div className="wrap">
        <p className="kicker">Inside GeoMetrikks</p>
        <h2 className="section-title">The logs must flow.</h2>
        <div className="tabs" role="tablist" aria-label="GeoMetrikks interface">
          {screens.map((screen, index) => (
            <button
              key={screen.id}
              id={`tab-screen-${screen.id}`}
              aria-controls={`panel-screen-${screen.id}`}
              {...tabProps(index)}
            >
              {screen.label}
            </button>
          ))}
        </div>
        {screens.map((screen, index) => {
          const image = screen.video ? null : shot(screen.img);
          const path = screen.path ?? (screen.id === "map" || screen.id === "ip-inspector" ? "map" : screen.id);
          return (
            <div
              key={screen.id}
              className="panel"
              id={`panel-screen-${screen.id}`}
              aria-labelledby={`tab-screen-${screen.id}`}
              {...panelProps(index)}
            >
              <div className={styles.frame}>
                <div className={styles.bar}>
                  <i />
                  <i />
                  <i />
                  <span>geometrikks.home.lan/{path}</span>
                </div>
                {image ? (
                  <a
                    className="zoom"
                    href={image.src}
                    data-zoom=""
                    data-zoom-alt={screen.alt}
                    data-zoom-caption={screen.cap}
                    aria-label={`View the ${screen.label} screenshot larger`}
                  >
                    <img
                      src={image.src}
                      width={image.width}
                      height={image.height}
                      alt={screen.alt}
                      loading={index === 0 ? "eager" : "lazy"}
                      decoding="async"
                    />
                    <ZoomHint />
                  </a>
                ) : (
                  <video
                    ref={video}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    poster={`${screen.video}-poster.jpg`}
                    width={1912}
                    height={1034}
                    aria-label={screen.alt}
                  >
                    <source src={`${screen.video}.webm`} type="video/webm" />
                    <source src={`${screen.video}.mp4`} type="video/mp4" />
                  </video>
                )}
              </div>
              <p className={styles.cap}>{screen.cap}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ZoomHint() {
  return (
    <span className="hint" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
      </svg>
      Enlarge
    </span>
  );
}
