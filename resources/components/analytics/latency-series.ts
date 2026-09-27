/** Row helpers for the latency chart's Percentile band view. */
import type { TooltipRow } from "@/lib/chart-tooltip"
import { latencyChartConfig } from "./chart-utils"

export type LatencyKey = keyof typeof latencyChartConfig
export const LATENCY_KEYS = Object.keys(latencyChartConfig) as LatencyKey[]

type LatencyValues = Partial<Record<LatencyKey, number | null>>

/**
 * Adds `band: [p50, p95]` for the range area. A string dataKey keeps the
 * tooltip and config lookups working; a function dataKey would not.
 */
export function bandRows<T extends LatencyValues>(rows: readonly T[]): Array<T & { band: [number, number] | null }> {
  return rows.map((row) => {
    const low = row.p50RequestTime
    const high = row.p95RequestTime
    return { ...row, band: low != null && high != null ? [low, high] : null }
  })
}

/**
 * The band view's tooltip: four scalar rows instead of the range pair. Each
 * row carries its own name and color because the band chart's config has no
 * p50 or p95 keys.
 */
export function latencyTooltipRows(row: unknown): TooltipRow[] {
  const values = row as LatencyValues & { raw?: LatencyValues }
  return LATENCY_KEYS.map((key) => ({
    dataKey: key,
    name: String(latencyChartConfig[key].label),
    value: values.raw?.[key] ?? values[key] ?? null,
    color: latencyChartConfig[key].color,
    payload: row,
  }))
}
