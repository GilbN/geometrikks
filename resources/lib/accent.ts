/** Brand accent variants. Teal is the default and renders without a
 * data-accent attribute; the CSS blocks live in main.css. */
export const ACCENTS = ["teal", "green", "copper"] as const

export type Accent = (typeof ACCENTS)[number]

export const DEFAULT_ACCENT: Accent = "teal"

export function parseAccent(value: string | null): Accent {
  return (ACCENTS as readonly string[]).includes(value ?? "")
    ? (value as Accent)
    : DEFAULT_ACCENT
}

/** The data-accent attribute value for an accent, or null when the
 * attribute should be absent (default accent). */
export function accentAttribute(accent: Accent): string | null {
  return accent === DEFAULT_ACCENT ? null : accent
}
