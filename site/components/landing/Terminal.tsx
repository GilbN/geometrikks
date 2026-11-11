"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import styles from "./Terminal.module.css";

// The hero's terminal: one log line through the pipeline, then a
// geometrikks-json line. Every line renders server-side; the effect only
// paces the reveal. Values are illustrative, not real traffic.
type Segment = { cls?: string; text: string };
type Line = Segment[] | null;
const lines: Line[] = [
  [
    { cls: "t-in", text: "access.log" },
    { text: '  203.0.113.7 - - [02/Sep/2026:23:41:07 +0000] "GET /wp-login.php HTTP/1.1" 403 153 "-" home.example.org "Mozilla/5.0 zgrab/0.x" "0.001" "-"' },
  ],
  [{ cls: "t-tag", text: "detect " }, { text: " format=" }, { cls: "t-val", text: "nginx" }, { text: "  (positional, $time_local)" }],
  [
    { cls: "t-tag", text: "parse  " },
    { text: " method=GET path=/wp-login.php status=" },
    { cls: "t-red", text: "403" },
    { text: " host=home.example.org bytes=153 rt=1ms" },
  ],
  [
    { cls: "t-tag", text: "geoip  " },
    { text: " 203.0.113.7 → " },
    { cls: "t-val", text: "Hanoi, VN" },
    { text: "  21.03, 105.85  AS135905 " },
    { cls: "t-dim", text: "(hosting)" },
  ],
  [{ cls: "t-tag", text: "store  " }, { text: " access_logs +1  geo_events +1  " }, { cls: "t-dim", text: "hypertable chunk 2026-09-02" }],
  [{ cls: "t-tag", text: "notify " }, { text: " /ws/live → 1 client  " }, { cls: "t-ok", text: "map: +1 marker, route → server" }],
  [
    { cls: "t-tag", text: "crowdsec" },
    { text: " decision for 203.0.113.7: " },
    { cls: "t-red", text: "ban" },
    { text: " (http-probing, 4h)  " },
    { cls: "t-dim", text: "still knocking: yes" },
  ],
  null,
  [
    { cls: "t-in", text: "access.log" },
    { text: '  {"client_ip":"198.51.100.24","timestamp":"2026-09-02T23:41:09+00:00","method":"GET","path":"/","status":"200","host":"blog.example.org","request_time":"0.018"}' },
  ],
  [{ cls: "t-tag", text: "detect " }, { text: " format=" }, { cls: "t-val", text: "geometrikks-json" }],
  [{ cls: "t-tag", text: "geoip  " }, { text: " 198.51.100.24 → " }, { cls: "t-val", text: "Toronto, CA" }, { text: "  43.65, -79.38  AS812" }],
  [{ cls: "t-tag", text: "notify " }, { text: " /ws/live → 1 client  " }, { cls: "t-ok", text: "map: +1 marker" }],
];

export function Terminal() {
  const body = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(lines.length);
      return;
    }
    setAnimating(true);
    let count = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      count = count === lines.length ? 1 : count + 1;
      setShown(count);
      timer = setTimeout(step, lines[count - 1] === null ? 1400 : 650);
    };
    step();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const element = body.current;
    if (animating && element && matchMedia("(max-width: 900px)").matches) element.scrollTop = element.scrollHeight;
  }, [animating, shown]);

  return (
    <div className={styles.term} aria-label="One log line moving through the ingestion pipeline">
      <div className={styles.bar}>
        <i />
        <i />
        <i />
        <span>geometrikks · ingestion</span>
      </div>
      <div className={styles.body} id="term" ref={body}>
        {lines.map((line, index) => {
          const className = index < shown ? `${styles.l} ${styles.on}` : styles.l;
          return (
            <Fragment key={index}>
              {line ? (
                <span className={className}>
                  {line.map((segment, part) =>
                    segment.cls ? (
                      <span key={part} className={styles[segment.cls]}>
                        {segment.text}
                      </span>
                    ) : (
                      segment.text
                    ),
                  )}
                </span>
              ) : (
                <span className={className} data-blank="">
                  {"\u00a0"}
                </span>
              )}
              {animating && index === shown - 1 && <span className={styles.caret} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
