/** Delta badge semantics for stat cards. `positive` means "this change is
 * good" (callers know whether up is good for their metric); tone colors
 * goodness, direction follows the numeric sign. Magnitudes that would
 * display as "0.0%" count as flat so a zero label never pairs with an
 * arrow. */
import { formatPercent } from "@/lib/api"

export type DeltaTone = "accent" | "destructive" | "muted"

/** What formatPercent prints for zero, minus its sign: the flat badge shows
 * this, so the two can never disagree on decimal places. */
export const FLAT_DELTA_LABEL = formatPercent(0).replace(/^\+/, "")

/** Half of the formatter's smallest step: anything below it would round to
 * FLAT_DELTA_LABEL. Derived from the label so a formatter change moves both. */
export const FLAT_DELTA_EPSILON =
  0.5 * 10 ** -(FLAT_DELTA_LABEL.replace("%", "").split(".")[1]?.length ?? 0)

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
