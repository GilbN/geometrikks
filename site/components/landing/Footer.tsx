import { Mark } from "@/components/brand/Mark";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="wrap">
        <Mark size={24} />
        <span>MIT licensed. Made in Norway.</span>
        <ul>
          <li>
            <a href="https://github.com/GilbN/geometrikks">GitHub</a>
          </li>
          <li>
            <a href="https://github.com/GilbN/geometrikks/releases">Releases</a>
          </li>
          <li>
            <a href="/docs/reference/changelog/">Changelog</a>
          </li>
          <li>
            <a href="/docs/sources/proxy-setup/">Proxy setup</a>
          </li>
          <li>
            <a href="/docs/reference/security/">Security</a>
          </li>
        </ul>
        <p className={styles.marks}>
          CrowdSec and the llama logo are trademarks of CrowdSec SAS. Other names and logos belong to their owners.
          GeoMetrikks is not affiliated with any of them.
        </p>
      </div>
    </footer>
  );
}
