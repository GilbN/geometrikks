/** Delta badge semantics for stat cards. `positive` means "this change is
 * good" (callers know whether up is good for their metric); tone colors
 * goodness, direction follows the numeric sign. */
export type DeltaTone = "accent" | "destructive" | "muted"

export function deltaTone(
  value: number | null | undefined,
  positive?: boolean
): DeltaTone | null {
  if (value === null || value === undefined) return null
  if (value === 0) return "muted"
  return (positive ?? value >= 0) ? "accent" : "destructive"
}

export function deltaDirection(value: number): "up" | "down" | "flat" {
  if (value === 0) return "flat"
  return value > 0 ? "up" : "down"
}
