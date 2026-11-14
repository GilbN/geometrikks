"use client";

import { useEffect, useState } from "react";
import { Mark } from "@/components/brand/Mark";
import { Wordmark } from "@/components/brand/Wordmark";
import styles from "./Nav.module.css";

const links = [
  { href: "#screens", label: "Tour" },
  { href: "#phone", label: "Phone" },
  { href: "#security", label: "Security" },
  { href: "#sources", label: "Sources" },
  { href: "#agents", label: "Agents" },
  { href: "#install", label: "Install" },
  { href: "/docs/", label: "Docs" },
];

export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const wide = matchMedia("(min-width: 901px)");
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      wide.removeEventListener("change", onWide);
    };
  }, []);

  return (
    <nav className={styles.nav} data-open={open ? "" : undefined}>
      <div className="wrap">
        <a className={styles.brand} href="/" aria-label="GeoMetrikks home">
          <Mark size={28} className="mark" />
          <Wordmark className="text-[16px]" />
        </a>
        <ul id="site-menu">
          {links.map((link) => (
            <li key={link.href} className={link.href === "/docs/" ? styles.docs : undefined}>
              <a href={link.href} onClick={() => setOpen(false)}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <a className="btn" href="https://github.com/GilbN/geometrikks">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </a>
        <button
          className={styles.menu}
          type="button"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label="Menu"
          onClick={() => setOpen(!open)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path className={styles.bars} d="M2 4h12M2 8h12M2 12h12" />
            <path className={styles.cross} d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
