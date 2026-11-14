import type { CSSProperties } from "react";
import styles from "./Features.module.css";

const rows = [
  {
    title: "Live tail",
    body: "New requests appear as your proxy logs them. Pause to read, and what arrives meanwhile waits in a buffer.",
    href: "/docs/features/app-tour/#live-tail",
  },
  {
    title: "Batch import",
    body: "Import rotated and archived log files, plain or gzipped, or a time range from Loki.",
    href: "/docs/operate/cli/",
  },
  {
    title: "HTTP API",
    body: "A documented API with a reference page per endpoint, and three WebSocket feeds.",
    href: "/docs/reference/api/",
  },
  {
    title: "API keys",
    body: "Read or Read/write keys for scripts and dashboards.",
    href: "/docs/features/authentication/api-keys/",
  },
  {
    title: "OpenID Connect",
    body: "Sign in through Authelia, Authentik, Keycloak, Pocket ID or Google, next to the admin password or in place of it.",
    href: "/docs/features/authentication/oidc/",
  },
  {
    title: "Eight themes",
    body: "Aurora, Moss, Forge, Night, Glacier, Dusk, Lyng and Storm, each with a light and a dark palette.",
    href: "/docs/features/app-tour/#appearance",
    themes: true,
  },
];

// Keep in step with the dark --brand-* values in resources/themes/.
const themes = [
  "oklch(0.78 0.15 178)",
  "oklch(0.76 0.17 155)",
  "oklch(0.72 0.11 60)",
  "oklch(0.93 0 0)",
  "oklch(0.75 0.13 248)",
  "oklch(0.75 0.14 285)",
  "oklch(0.77 0.13 335)",
  "oklch(0.8 0.055 250)",
];

export function Features() {
  return (
    <section className={styles.features} id="features">
      <div className="wrap">
        <h2 className="section-title">Also built in.</h2>
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.title}>
              <a href={row.href}>
                <b>{row.title}</b>
                <span>
                  {row.body}
                  {row.themes && (
                    <span className={styles.themes} aria-hidden="true">
                      {themes.map((color) => (
                        <i key={color} style={{ "--dot": color } as CSSProperties} />
                      ))}
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
