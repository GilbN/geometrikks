"use client";

import { useEffect, useRef } from "react";
import screenshots from "@/.generated/screenshots.json";
import { type Manifest, sceneEntry, shotSrc, variant } from "@/lib/screenshots";
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
  { id: "map", label: "Map", video: { src: "/media/map", label: "The live map with marker clusters, a live request feed and live routes to several servers, then a request popup, the IP inspector for a banned address, the globe and the Satellite view" }, cap: "Live map. Show requests as markers, clusters or a heatmap on a flat map or globe, over a street map or satellite imagery. Switch to the Banned IPs view to see where CrowdSec bans come from. Live routes end at the server location you configure." },
  { id: "overview", label: "Overview", scene: "dashboard", cap: "Overview. Requests, visitors, bandwidth and errors for the chosen time period, compared with the previous period." },
  { id: "analytics", label: "Analytics", scene: "analytics", cap: "Analytics. Request volume, response codes, latency percentiles, bandwidth, top URLs by host, user agents and ASNs." },
  { id: "access-logs", label: "Access logs", scene: "access-logs", cap: "Access logs. Search every request and filter by status, method, IP, host, country or server." },
  { id: "geo-logs", label: "Geo logs", scene: "geo-logs", cap: "Geo logs. Traffic grouped by place: which locations send requests and how that changes over time." },
  { id: "ip-inspector", label: "IP inspector", scene: "ip-inspector", cap: "IP inspector. Select an address to see its network, request counts, bandwidth, response codes over time, hosts, paths, user agents and recent requests. Its CrowdSec decision, any Spamhaus DROP listing and its AbuseIPDB score sit at the top, and you can ban it or report it from there." },
  { id: "security", label: "Security", scene: "security", cap: "Security. One tab each for CrowdSec decisions and alerts, the Spamhaus DROP networks in your traffic, and the reports you sent to AbuseIPDB. Decisions show each address's country and scenario, and with machine credentials the DROP tab bans a whole network." },
  { id: "debug-logs", label: "Debug logs", scene: "debug-logs", cap: "Debug logs. Source lines that failed to parse, each with its parse error. Turn on debug capture and it keeps the lines that parsed too, linked to their requests." },
  { id: "status", label: "Status", path: "settings/status", scene: "status", cap: "Status. Ingestion, database, GeoIP and CrowdSec health on one page, with every log source listed and how much each has read. Advisories flag what needs attention, such as a missing ASN database." },
];

// The map tab is a clip, so its phone shot is placed by hand where ShotPair
// would put one.
const livePhone = (() => {
  const shot = variant(sceneEntry(screenshots as Manifest, "live"), "phone", "dark");
  if (!shot) throw new Error("screenshot scene live has no phone-dark variant");
  return shot;
})();

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
                  <div className={styles.clip}>
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
                      {/* mp4 first: iPhone Safari takes the WebM when it is listed first and stalls a second in. */}
                      <source src={`${screen.video?.src}.mp4`} type="video/mp4" />
                      <source src={`${screen.video?.src}.webm`} type="video/webm" />
                    </video>
                    <img
                      src={shotSrc(livePhone)}
                      width={livePhone.width}
                      height={livePhone.height}
                      alt="The live map on a phone, with routes arriving at the server."
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
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
