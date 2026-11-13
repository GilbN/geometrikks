import { Mark } from "@/components/brand/Mark";
import styles from "./Footer.module.css";

// Follows the docs sidebar's main pages in content/docs/next/*/meta.json. Change both together.
const groups = [
  {
    title: "Get started",
    links: [
      { href: "/docs/", label: "Introduction" },
      { href: "/docs/get-started/quickstart/", label: "Quickstart" },
      { href: "/docs/get-started/geolite2/", label: "GeoLite2 and the CARTO key" },
      { href: "/docs/get-started/upgrading/", label: "Upgrading" },
    ],
  },
  {
    title: "Log sources",
    links: [
      { href: "/docs/sources/nginx/", label: "nginx" },
      { href: "/docs/sources/nginx-proxy-manager/", label: "Nginx Proxy Manager" },
      { href: "/docs/sources/traefik/", label: "Traefik" },
      { href: "/docs/sources/caddy/", label: "Caddy" },
      { href: "/docs/sources/loki/", label: "Grafana Loki" },
      { href: "/docs/sources/multiple-sources/", label: "Multiple sources" },
      { href: "/docs/sources/proxy-setup/", label: "Real client IP behind a proxy" },
    ],
  },
  {
    title: "Features",
    links: [
      { href: "/docs/features/map/", label: "Map" },
      { href: "/docs/features/app-tour/", label: "The app, page by page" },
      { href: "/docs/features/crowdsec/", label: "CrowdSec" },
      { href: "/docs/features/drop-lists/", label: "Spamhaus DROP lists" },
      { href: "/docs/features/ip-inspector/", label: "IP inspector" },
      { href: "/docs/features/abuse-reports/", label: "Abuse reports" },
      { href: "/docs/features/abuseipdb/", label: "AbuseIPDB" },
      { href: "/docs/features/authentication/", label: "Login and sessions" },
    ],
  },
  {
    title: "Operate",
    links: [
      { href: "/docs/operate/reverse-proxy/", label: "Reverse proxy" },
      { href: "/docs/operate/deployment/", label: "Deployment" },
      { href: "/docs/operate/cli/", label: "CLI" },
      { href: "/docs/operate/faq/", label: "FAQ" },
    ],
  },
  {
    title: "Reference",
    links: [
      { href: "/docs/reference/configuration/", label: "Configuration" },
      { href: "/docs/reference/api/", label: "API reference" },
      { href: "/docs/reference/changelog/", label: "Changelog" },
      { href: "/docs/reference/security/", label: "Security" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: "https://github.com/GilbN/geometrikks", label: "GitHub" },
      { href: "https://github.com/GilbN/geometrikks/releases", label: "Releases" },
      { href: "/docs/contribute/development/", label: "Development" },
    ],
  },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="wrap">
        <div className={styles.lead}>
          <h2 className="section-title">The rest is in the docs.</h2>
          <p className="sub">Setup for each proxy, every setting, the CLI and the API reference.</p>
          <a className="btn primary" href="/docs/">
            Read the docs
          </a>
        </div>
        <nav className={styles.map} aria-label="Site map">
          {groups.map((group) => (
            <div key={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className={styles.legal}>
          <p className={styles.made}>
            <Mark size={24} />
            MIT licensed. Made in Norway.
          </p>
          <p>
            CrowdSec and the llama logo are trademarks of CrowdSec SAS. Other names and logos belong to their owners.
            GeoMetrikks is not affiliated with any of them.
          </p>
        </div>
      </div>
    </footer>
  );
}
