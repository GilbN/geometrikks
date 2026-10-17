import { ACCENTS, DEFAULT_ACCENT } from "./accent.ts"
import {
  DARK_APPEARANCE_CATALOG,
  DARK_APPEARANCES,
  DEFAULT_DARK_APPEARANCE,
  LIGHT_PALETTE,
  THEMES,
  THEME_STORAGE_KEYS,
} from "./theme.ts"

/** Inline, synchronous startup code. Both the HTML build and tests use this. */
export function themeHead(): string {
  const config = JSON.stringify({
    modes: THEMES,
    appearances: DARK_APPEARANCES,
    palettes: DARK_APPEARANCE_CATALOG,
    defaultAppearance: DEFAULT_DARK_APPEARANCE,
    light: LIGHT_PALETTE,
    keys: THEME_STORAGE_KEYS,
    accents: ACCENTS,
    defaultAccent: DEFAULT_ACCENT,
  }).replaceAll("<", "\\u003c")

  return `<script>
    (function(config) {
      function read(key) {
        try { return localStorage.getItem(key); } catch { return null; }
      }
      const savedMode = read(config.keys.mode);
      const mode = config.modes.includes(savedMode) ? savedMode : 'dark';
      const savedAppearance = read(config.keys.appearance);
      const appearance = config.appearances.includes(savedAppearance) ? savedAppearance : config.defaultAppearance;
      const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const root = document.documentElement;
      root.classList.add(dark ? 'dark' : 'light');
      root.setAttribute('data-dark-appearance', appearance);
      root.style.colorScheme = dark ? 'dark' : 'light';
      const palette = dark ? config.palettes[appearance] : config.light;
      root.style.setProperty('--startup-background', palette.themeColor);
      root.style.setProperty('--startup-foreground', palette.foreground);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.themeColor);
      const accent = read(config.keys.accent);
      if (config.accents.includes(accent) && accent !== config.defaultAccent) root.setAttribute('data-accent', accent);
    })(${config});
  </script>
  <style>
    /* Palette variables take over as soon as the render-blocking CSS loads. */
    html, body {
      background-color: var(--background, var(--startup-background));
      color: var(--foreground, var(--startup-foreground));
    }
  </style>`
}
