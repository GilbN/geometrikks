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

/** The dark palette is independent of the light/dark/system preference. */
type AppearanceDefinition = {
  label: string
  description: string
  themeColor: string
  foreground: string
}

export const DARK_APPEARANCE_CATALOG = {
  aurora: {
    label: "Aurora",
    description: "Blue-tinted surfaces and map contours.",
    themeColor: "#010810",
    foreground: "oklch(0.95 0.01 220)",
  },
  black: {
    label: "Black",
    description: "Near-black with subtly lighter panels.",
    themeColor: "#0a0a0a",
    foreground: "#e8e8e8",
  },
} as const satisfies Record<string, AppearanceDefinition>

export type DarkAppearance = keyof typeof DARK_APPEARANCE_CATALOG
export const DARK_APPEARANCES = Object.keys(DARK_APPEARANCE_CATALOG) as DarkAppearance[]
export const DEFAULT_DARK_APPEARANCE: DarkAppearance = "aurora"
export const LIGHT_PALETTE = { themeColor: "#f0f6f9", foreground: "oklch(0.22 0.03 250)" } as const

export const THEME_STORAGE_KEYS = {
  mode: "geometrikks-theme",
  appearance: "geometrikks-dark-appearance",
  accent: "geometrikks-accent",
} as const

export function parseDarkAppearance(value: string | null): DarkAppearance {
  return (DARK_APPEARANCES as readonly string[]).includes(value ?? "")
    ? (value as DarkAppearance)
    : DEFAULT_DARK_APPEARANCE
}

/** Browser chrome follows the selected appearance, including in System mode. */
export function themeColor(theme: ResolvedTheme, appearance: DarkAppearance): string {
  return theme === "light" ? LIGHT_PALETTE.themeColor : DARK_APPEARANCE_CATALOG[appearance].themeColor
}
