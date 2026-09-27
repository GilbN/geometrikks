/**
 * Y-axis scaling helpers for the time-series charts.
 */
import type { ChartScale } from "./chart-options"

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
export function clampedYMax(values: ReadonlyArray<number | null | undefined>): number | null {
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


/** Y-axis props a chart spreads onto `<YAxis>`; empty means Recharts defaults. */
export type YAxisScaleProps = {
  scale?: "log"
  domain?: [number, number | "auto"]
  ticks?: number[]
  allowDataOverflow?: boolean
}

export type LogAxis = {
  scale: "log"
  domain: [number, number]
  ticks: number[]
  allowDataOverflow: true
}

/** Largest integer exponent e with base ** e <= x, robust to float error in Math.log. */
function exponentAtOrBelow(x: number, base: number): number {
  let e = Math.floor(Math.log(x) / Math.log(base))
  if (base ** (e + 1) <= x) e += 1
  if (base ** e > x) e -= 1
  return e
}

/**
 * Log-scale axis whose minimum sits strictly below every positive value, so
 * the smallest real bucket still draws with visible height and floored zeros
 * sit on the bottom edge alone. See the spec's "Log axis" section.
 */
export function logAxis(
  values: ReadonlyArray<number | null | undefined>,
  { base = 10, integer = false }: { base?: 10 | 1024; integer?: boolean } = {},
): LogAxis {
  const positive = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
  let low = 0
  let high = 1
  if (positive.length > 0) {
    const min = Math.min(...positive)
    const max = Math.max(...positive)
    const e = exponentAtOrBelow(min, base)
    low = min >= 2 * base ** e ? e : e - 1
    const top = exponentAtOrBelow(max, base)
    high = base ** top >= max ? top : top + 1
    if (high <= low) high = low + 1
  }
  const count = high - low + 1
  const step = count > 6 ? Math.ceil(count / 6) : 1
  const ticks: number[] = []
  for (let e = low; e <= high; e++) {
    if ((e - low) % step === 0 || e === high) ticks.push(base ** e)
  }
  return {
    scale: "log",
    domain: [base ** low, base ** high],
    ticks: integer ? ticks.filter((t) => t >= 1) : ticks,
    allowDataOverflow: true,
  }
}

/**
 * Copies `rows`, raising every listed value <= 0 to `min` (the log axis
 * minimum) so d3's log scale never sees 0. `raw` keeps the original values
 * for the tooltip; null stays null so missing data still leaves a gap.
 */
export function floorForLog<T extends object, K extends keyof T & string>(
  rows: readonly T[],
  keys: readonly K[],
  min: number,
): { rows: Array<T & { raw: Pick<T, K> }>; raised: number } {
  let raised = 0
  const out = rows.map((row) => {
    const copy = { ...row, raw: {} as Pick<T, K> }
    for (const key of keys) {
      const value = row[key]
      copy.raw[key] = value
      if (typeof value === "number" && value <= 0) {
        ;(copy as Record<K, unknown>)[key] = min
        raised += 1
      }
    }
    return copy
  })
  return { rows: out, raised }
}

export type ScaledSeries<T, K extends keyof T> = {
  rows: Array<T & { raw?: Pick<T, K> }>
  axis: YAxisScaleProps
  clipMax: number | null
  zerosRaised: number
}

/**
 * Rows and y-axis props for one chart under the chosen scale. `clipValues`
 * overrides what clipping looks at (the status stack clips on bucket totals).
 */
export function scaleSeries<T extends object, K extends keyof T & string>(
  rows: readonly T[],
  keys: readonly K[],
  scale: ChartScale,
  options: {
    base?: 10 | 1024
    integer?: boolean
    clipValues?: ReadonlyArray<number | null | undefined>
  } = {},
): ScaledSeries<T, K> {
  const values = rows.flatMap((row) => keys.map((key) => row[key] as unknown as number | null | undefined))
  if (scale === "log") {
    const axis = logAxis(values, options)
    const floored = floorForLog(rows, keys, axis.domain[0])
    return { rows: floored.rows, axis, clipMax: null, zerosRaised: floored.raised }
  }
  const clipMax = scale === "clip" ? clampedYMax(options.clipValues ?? values) : null
  return {
    rows: [...rows],
    axis: clipMax != null ? { domain: [0, clipMax], allowDataOverflow: true } : {},
    clipMax,
    zerosRaised: 0,
  }
}
