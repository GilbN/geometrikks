"use client";

import { type KeyboardEvent, useRef, useState } from "react";

/**
 * Minimal ARIA tabs: click or arrow keys switch panels. Panels render with the
 * hidden attribute, so without scripting landing.css shows them all and hides the strip.
 */
export function useTabs(count: number) {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const tabProps = (index: number) => ({
    role: "tab",
    "aria-selected": index === selected,
    tabIndex: index === selected ? 0 : -1,
    ref: (tab: HTMLButtonElement | null) => {
      tabs.current[index] = tab;
    },
    onClick: () => setSelected(index),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      const next = (index + delta + count) % count;
      tabs.current[next]?.focus();
      setSelected(next);
    },
  });

  const panelProps = (index: number) => ({ role: "tabpanel", hidden: index !== selected });

  return { selected, tabProps, panelProps };
}
