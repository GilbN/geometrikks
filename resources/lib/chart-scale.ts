/**
 * Y-axis scaling helpers for the time-series charts.
 */

/** Round up to the next 1 / 2 / 2.5 / 5 / 10 step of the value's decade. */
export function niceCeil(x: number): number {
  const base = 10 ** Math.floor(Math.log10(x))
  const step = [1, 2, 2.5, 5, 10].find((s) => x / base <= s) ?? 10
  return step * base
}

/**
 * Y-axis max for spike-dominated series, or null when no clamping is needed.
 *
 * A single burst bucket can stretch a linear axis until normal traffic renders
 * sub-pixel. When the true max dwarfs the top-2% reference bucket, return a
 * nice-rounded axis max just above that reference; marks beyond it clip at the
 * plot edge (tooltips still carry the real values).
 */
export function clampedYMax(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => Number.isFinite(v))
  if (finite.length < 6) return null
  const sorted = [...finite].sort((a, b) => a - b)
  const spikeCount = Math.max(1, Math.floor(sorted.length * 0.02))
  const reference = sorted[sorted.length - 1 - spikeCount]
  const max = sorted[sorted.length - 1]
  if (reference <= 0 || max <= reference * 2.5) return null
  const clamped = niceCeil(reference * 1.2)
  return clamped < max ? clamped : null
}
