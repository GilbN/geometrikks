/** Color mode. "system" follows prefers-color-scheme and re-resolves when
 * the OS setting changes while the app is open. */
export const THEMES = ["system", "light", "dark"] as const

export type Theme = (typeof THEMES)[number]

export function parseTheme(value: string | null, fallback: Theme = "system"): Theme {
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : fallback
}
