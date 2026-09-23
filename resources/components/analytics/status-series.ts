/** Row and axis helpers for the status chart's Share and Error rate views. */
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import type { ChartScale } from "@/lib/chart-options"
import { clampedYMax, type YAxisScaleProps } from "@/lib/chart-scale"
import { formatRate, statusChartConfig } from "./chart-utils"

export type StatusKey = keyof typeof statusChartConfig
export const STATUS_KEYS = Object.keys(statusChartConfig) as StatusKey[]
export const SHARE_TICKS = [0, 0.25, 0.5, 0.75, 1]

type StatusCounts = Record<StatusKey, number | null>

/** Sum of the four classes; 1xx is in totalRequests but in no class. */
export function statusTotal(row: StatusCounts): number {
  return STATUS_KEYS.reduce((sum, key) => sum + (row[key] ?? 0), 0)
}

export type ShareRow = Omit<TimeSeriesDataPoint, StatusKey> & StatusCounts

/** Zero-sum buckets get null classes, so stacked areas show a gap, not a dip to 0. */
export function shareRows(points: readonly TimeSeriesDataPoint[]): ShareRow[] {
  return points.map((point) =>
    statusTotal(point) > 0
      ? point
      : { ...point, status2xx: null, status3xx: null, status4xx: null, status5xx: null })
}

/** Tooltip text for the Share view: "1,234 (82.3%)". */
export function shareLabel(value: unknown, row: unknown): string {
  if (typeof value !== "number") return "n/a"
  const total = statusTotal(row as StatusCounts)
  return total > 0 ? `${formatNumber(value)} (${formatRate(value / total)})` : "n/a"
}

export type ErrorRateRow = Omit<TimeSeriesDataPoint, "errorRate"> & { errorRate: number | null }

export function errorRateSeries(
  points: readonly TimeSeriesDataPoint[],
  scale: ChartScale,
): { rows: ErrorRateRow[]; axis: YAxisScaleProps; clipMax: number | null } {
  // The API reports 0 for empty buckets; that is "no data", not "no errors".
  const rows = points.map((point) => ({ ...point, errorRate: point.totalRequests > 0 ? point.errorRate : null }))
  const rates = rows.map((row) => row.errorRate)
  const clip = scale === "clip" ? clampedYMax(rates) : null
  if (clip != null && clip < 1) {
    return { rows, axis: { domain: [0, clip], allowDataOverflow: true }, clipMax: clip }
  }
  // Recharts turns a [0, 0] domain into ticks 0..4, which would read as 400%.
  const max = Math.max(0, ...rates.filter((rate): rate is number => rate != null))
  return { rows, axis: { domain: max > 0 ? [0, "auto"] : [0, 1] }, clipMax: null }
}
