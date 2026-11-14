"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./Lightbox.module.css";

// One dialog for every screenshot on the page. Any <a data-zoom> opens its
// href in here; without scripting the link opens the full image instead.
type Shot = { src: string; alt: string; caption: string };

export function Lightbox() {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [shot, setShot] = useState<Shot | null>(null);

  useEffect(() => {
    if (typeof dialog.current?.showModal !== "function") return;
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-zoom]");
      if (!link) return;
      event.preventDefault();
      setShot({ src: link.href, alt: link.dataset.zoomAlt ?? "", caption: link.dataset.zoomCaption ?? "" });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (shot && !dialog.current?.open) dialog.current?.showModal();
  }, [shot]);

  return (
    <dialog
      ref={dialog}
      className={styles.lightbox}
      aria-label="Screenshot"
      // The figure fills only the image's box, so any click outside it, on
      // the backdrop or the image itself, closes.
      onClick={(event) => {
        if (event.target === dialog.current || event.target === image.current) dialog.current?.close();
      }}
      onClose={() => setShot(null)}
    >
      <button className={styles.close} type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
      <figure>
        <img ref={image} src={shot?.src} alt={shot?.alt ?? ""} decoding="async" />
        <figcaption>{shot?.caption}</figcaption>
      </figure>
    </dialog>
  );
}
