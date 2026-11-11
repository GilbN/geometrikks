import styles from "./Features.module.css";

const cells = [
  { title: "Live tail", body: "Watch new requests arrive on the access logs page. The feed pauses while you hover so rows do not move under the cursor.", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2" },
  { title: "Access logs", body: "Search every request and filter by status, method, IP, host, country or server. Results are paginated in the database.", icon: "M4 6h16M4 12h16M4 18h10" },
  { title: "IP inspector", body: "Open an address to see its request count, bandwidth, status codes, user agents, hosts and paths. Check its CrowdSec status or ban it there.", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4" },
  { title: "Geo logs", body: "Group traffic by country and city, compare activity over time, and see the top IPs and locations for the selected range.", icon: "M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" },
  { title: "Batch import", body: "Import rotated logs, gzipped or not, including Nginx Proxy Manager's own. Checksums skip repeat files, and a cutoff time skips lines already ingested.", icon: "M12 4v10m0 0 4-4m-4 4-4-4M4 17v3h16v-3" },
  { title: "Debug logs", body: "Inspect the raw line for each parsed request. Parse failures appear here too, so you can find log lines GeoMetrikks could not read.", icon: "M8 9l-4 3 4 3m8-6 4 3-4 3m-3-9-2 12" },
];

export function Features() {
  return (
    <section className={styles.features} id="features">
      <div className="wrap">
        <p className="kicker">Request details</p>
        <h2 className="section-title">Search, filter and inspect the requests behind the map.</h2>
        <div className={styles.grid}>
          {cells.map((cell) => (
            <div key={cell.title} className={`${styles.cell} card`}>
              <h3>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d={cell.icon} />
                </svg>
                {cell.title}
              </h3>
              <p>{cell.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
