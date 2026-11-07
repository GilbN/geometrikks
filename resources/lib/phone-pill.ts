export const PILL_WIDTH = 54
export const PILL_WIDTH_COMPACT = 50

/** Four 44px buttons, four 40px buttons, or Layers and Live alone. */
export type PillSize = "full" | "compact" | "two"

/** The pill's size for the room between the range chip and 12px above the bar. */
export function pillSize(available: number): PillSize {
  if (available >= 192) return "full"
  if (available >= 176) return "compact"
  return "two"
}
