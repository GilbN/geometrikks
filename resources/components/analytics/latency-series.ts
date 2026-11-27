/** Row helpers for the latency chart's Percentile band view. */
import { latencyChartConfig } from "./chart-utils"

export type LatencyKey = keyof typeof latencyChartConfig
export const LATENCY_KEYS = Object.keys(latencyChartConfig) as LatencyKey[]

type LatencyValues = Partial<Record<LatencyKey, number | null>>

/**
 * Adds `band: [p50, p95]` for the range area. A string dataKey keeps the
 * config lookups working; a function dataKey would not.
 */
export function bandRows<T extends LatencyValues>(
  rows: readonly T[],
): Array<T & { band: [number, number] | null }> {
  return rows.map((row) => {
    const low = row.p50RequestTime
    const high = row.p95RequestTime
    return { ...row, band: low != null && high != null ? [low, high] : null }
  })
}
