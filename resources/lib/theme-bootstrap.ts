import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  LEGACY_ACCENT_THEMES,
  THEME_CATALOG,
  THEMES,
  THEME_STORAGE_KEYS,
} from "./theme.ts"

/** Inline, synchronous startup code. Both the HTML build and tests use this. */
export function themeHead(): string {
  const config = JSON.stringify({
    modes: THEMES,
    themes: COLOR_THEMES,
    catalog: THEME_CATALOG,
    defaultTheme: DEFAULT_COLOR_THEME,
    legacy: LEGACY_ACCENT_THEMES,
    keys: THEME_STORAGE_KEYS,
  }).replaceAll("<", "\\u003c")

  return `<script>
    (function(config) {
      function read(key) {
        try { return localStorage.getItem(key); } catch { return null; }
      }
      const savedMode = read(config.keys.mode);
      const mode = config.modes.includes(savedMode) ? savedMode : 'dark';
      const savedTheme = read(config.keys.theme);
      const legacyTheme = config.legacy[read(config.keys.legacyAccent)];
      const theme = config.themes.includes(savedTheme)
        ? savedTheme
        : config.themes.includes(legacyTheme) ? legacyTheme : config.defaultTheme;
      const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const root = document.documentElement;
      root.classList.add(dark ? 'dark' : 'light');
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = dark ? 'dark' : 'light';
      const palette = config.catalog[theme][dark ? 'dark' : 'light'];
      root.style.setProperty('--startup-background', palette.themeColor);
      root.style.setProperty('--startup-foreground', palette.foreground);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.themeColor);
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
