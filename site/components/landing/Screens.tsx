"use client";

import { useEffect, useRef } from "react";
import { ShotPair } from "../ShotPair";
import styles from "./Screens.module.css";
import { useTabs } from "./useTabs";

// One screenshot at a time behind a tab strip. All panels render; the
// component only toggles hidden and starts or stops the map clip. Screenshots
// come from data/screenshots via prepare.ts; the clip lives in public/media.
type Screen = {
  id: string;
  label: string;
  cap: string;
  scene?: string;
  video?: { src: string; label: string };
  path?: string;
};

const screens: Screen[] = [
  { id: "map", label: "Map", video: { src: "/media/map", label: "The live map with marker clusters, a live request feed, a live route to the server location, and map controls offering the Heatmap, Markers and Banned views" }, cap: "Live map. Show requests as markers, clusters or a heatmap on a flat map or globe, over a street map or satellite imagery. Switch to the Banned IPs view to see where CrowdSec bans come from. Live routes end at the server location you configure." },
  { id: "overview", label: "Overview", scene: "dashboard", cap: "Overview. Requests, visitors, bandwidth and errors for the chosen time period, compared with the previous period." },
  { id: "analytics", label: "Analytics", scene: "analytics", cap: "Analytics. Request volume, response codes, latency percentiles, bandwidth, top URLs by host, user agents and ASNs." },
  { id: "access-logs", label: "Access logs", scene: "access-logs", cap: "Access logs. Search every request and filter by status, method, IP, host, country or server." },
  { id: "geo-logs", label: "Geo logs", scene: "geo-logs", cap: "Geo logs. Traffic grouped by place: which locations send requests and how that changes over time." },
  { id: "ip-inspector", label: "IP inspector", scene: "ip-inspector", cap: "IP inspector. Select an address to see its network, request counts, bandwidth, response codes over time, hosts, paths, user agents and recent requests. Its CrowdSec decision and any Spamhaus DROP listing sit at the top, and you can ban it from there." },
  { id: "security", label: "Security", scene: "security", cap: "Security. Active CrowdSec decisions with each address's country and scenario, and the Spamhaus DROP networks in your traffic with a button to ban them." },
  { id: "debug-logs", label: "Debug logs", scene: "debug-logs", cap: "Debug logs. Source lines that failed to parse, each with its parse error. Turn on debug capture and it keeps the lines that parsed too, linked to their requests." },
  { id: "status", label: "Status", path: "settings/status", scene: "status", cap: "Status. Ingestion, database, GeoIP and CrowdSec health on one page, with every log source listed and how much each has read. Advisories flag what needs attention, such as a missing ASN database." },
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
                {screen.scene ? (
                  <div className={styles.pair}>
                    <ShotPair scene={screen.scene} theme="dark" caption={screen.cap} zoom />
                  </div>
                ) : (
                  <video
                    ref={video}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    poster={`${screen.video?.src}-poster.jpg`}
                    width={1912}
                    height={1034}
                    aria-label={screen.video?.label}
                  >
                    <source src={`${screen.video?.src}.webm`} type="video/webm" />
                    <source src={`${screen.video?.src}.mp4`} type="video/mp4" />
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
