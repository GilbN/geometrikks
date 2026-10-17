/** Color mode. "system" follows prefers-color-scheme and re-resolves when
 * the OS setting changes while the app is open. */
export const THEMES = ["system", "light", "dark"] as const

export type Theme = (typeof THEMES)[number]

export function parseTheme(value: string | null, fallback: Theme = "system"): Theme {
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : fallback
}

export type ResolvedTheme = Exclude<Theme, "system">

/** The mode a preference lands on once "system" is read against the OS setting. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light"
  return theme
}

type SchemeColors = { themeColor: string; foreground: string }

type ThemeDefinition = {
  label: string
  description: string
  light: SchemeColors
  dark: SchemeColors
}

/** `themeColor` must be the hex of that scheme's computed --background: it
 * paints before the stylesheet loads and the first-paint test compares them. */
export const THEME_CATALOG = {
  aurora: {
    label: "Aurora",
    description: "Fjord mist and Aurora night, teal. The default.",
    light: { themeColor: "#f0f6f9", foreground: "oklch(0.22 0.03 250)" },
    dark: { themeColor: "#010810", foreground: "oklch(0.95 0.01 220)" },
  },
  moss: {
    label: "Moss",
    description: "Green, with surfaces tinted to match.",
    light: { themeColor: "#f1f7f3", foreground: "oklch(0.22 0.025 165)" },
    dark: { themeColor: "#010a06", foreground: "oklch(0.95 0.01 160)" },
  },
  forge: {
    label: "Forge",
    description: "Copper, with warm neutral surfaces.",
    light: { themeColor: "#f8f4f1", foreground: "oklch(0.22 0.015 55)" },
    dark: { themeColor: "#0c0806", foreground: "oklch(0.95 0.008 70)" },
  },
  black: {
    label: "Black",
    description: "Plain white or near-black, no tint, monochrome buttons.",
    light: { themeColor: "#f5f5f5", foreground: "#171717" },
    dark: { themeColor: "#0a0a0a", foreground: "#e8e8e8" },
  },
} as const satisfies Record<string, ThemeDefinition>

export type ColorTheme = keyof typeof THEME_CATALOG
export const COLOR_THEMES = Object.keys(THEME_CATALOG) as ColorTheme[]
export const DEFAULT_COLOR_THEME: ColorTheme = "aurora"

/** Accents saved before themes existed, mapped to the theme that replaced them. */
export const LEGACY_ACCENT_THEMES: Record<string, ColorTheme> = {
  teal: "aurora",
  green: "moss",
  copper: "forge",
}

export const THEME_STORAGE_KEYS = {
  mode: "geometrikks-theme",
  theme: "geometrikks-color-theme",
  legacyAccent: "geometrikks-accent",
} as const

function isColorTheme(value: string | null | undefined): value is ColorTheme {
  return (COLOR_THEMES as readonly string[]).includes(value ?? "")
}

/** The startup script in theme-bootstrap.ts repeats this rule. */
export function parseColorTheme(saved: string | null, legacyAccent: string | null): ColorTheme {
  if (isColorTheme(saved)) return saved
  const legacy: string | undefined = LEGACY_ACCENT_THEMES[legacyAccent ?? ""]
  return isColorTheme(legacy) ? legacy : DEFAULT_COLOR_THEME
}

export function themeColor(scheme: ResolvedTheme, theme: ColorTheme): string {
  return THEME_CATALOG[theme][scheme].themeColor
}
