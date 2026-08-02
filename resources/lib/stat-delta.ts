/** Delta badge semantics for stat cards. `positive` means "this change is
 * good" (callers know whether up is good for their metric); tone colors
 * goodness, direction follows the numeric sign. Magnitudes that would
 * display as "0.0%" count as flat so a zero label never pairs with an
 * arrow. */
export type DeltaTone = "accent" | "destructive" | "muted"

/** formatPercent renders one decimal, so below this magnitude the badge
 * text reads "0.0%". */
export const FLAT_DELTA_EPSILON = 0.05

export function deltaTone(
  value: number | null | undefined,
  positive?: boolean
): DeltaTone | null {
  if (value == null || !Number.isFinite(value)) return null
  if (Math.abs(value) < FLAT_DELTA_EPSILON) return "muted"
  return (positive ?? value >= 0) ? "accent" : "destructive"
}

export function deltaDirection(value: number): "up" | "down" | "flat" {
  if (Math.abs(value) < FLAT_DELTA_EPSILON) return "flat"
  return value > 0 ? "up" : "down"
}
