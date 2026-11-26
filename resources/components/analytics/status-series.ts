/** Row and axis helpers for the status chart's Share and Error rate views. */
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { ChartScale } from "@/lib/chart-options"
import { clampedYMax, type YAxisScaleProps } from "@/lib/chart-scale"
import type { ChartConfig } from "@/components/ui/chart"
import { statusChartConfig } from "./chart-utils"

export type StatusKey = keyof typeof statusChartConfig
export const STATUS_KEYS = Object.keys(statusChartConfig) as StatusKey[]
export const SHARE_TICKS = [0, 0.25, 0.5, 0.75, 1]

type StatusCounts = Record<StatusKey, number | null>

/** Sum of the four classes; 1xx is in totalRequests but in no class. */
export function statusTotal(row: StatusCounts): number {
  return STATUS_KEYS.reduce((sum, key) => sum + (row[key] ?? 0), 0)
}

/** Requests outside the four classes. The chart draws them only on ranges that have some. */
export const otherChartConfig = {
  statusOther: { label: "1xx and no response", color: "var(--chart-5)" },
} satisfies ChartConfig

export type CountRow = TimeSeriesDataPoint & { statusOther: number }

/**
 * Adds the requests totalRequests counts and no class holds: 1xx, and status
 * 0 for a connection that closed before any response. On a WebSocket host the
 * 101 upgrades can be most of an hour's requests.
 */
export function withOther(points: readonly TimeSeriesDataPoint[]): CountRow[] {
  return points.map((point) => ({
    ...point,
    statusOther: Math.max(0, point.totalRequests - statusTotal(point)),
  }))
}

export type ShareRow = Omit<TimeSeriesDataPoint, StatusKey> & StatusCounts

/** Zero-sum buckets get null classes, so stacked areas show a gap, not a dip to 0. */
export function shareRows(points: readonly TimeSeriesDataPoint[]): ShareRow[] {
  return points.map((point) =>
    statusTotal(point) > 0
      ? point
      : { ...point, status2xx: null, status3xx: null, status4xx: null, status5xx: null },
  )
}

/**
 * A value whose neighbours are both missing. A line through it has a single
 * point, which Recharts draws as nothing, so the chart marks it with a dot.
 */
export function isIsolated(
  values: ReadonlyArray<number | null | undefined>,
  index: number,
): boolean {
  return values[index] != null && values[index - 1] == null && values[index + 1] == null
}

export type ErrorRateRow = Omit<TimeSeriesDataPoint, "errorRate"> & { errorRate: number | null }

export function errorRateSeries(
  points: readonly TimeSeriesDataPoint[],
  scale: ChartScale,
): { rows: ErrorRateRow[]; axis: YAxisScaleProps; clipMax: number | null } {
  // The API reports 0 for empty buckets; that is "no data", not "no errors".
  const rows = points.map((point) => ({
    ...point,
    errorRate: point.totalRequests > 0 ? point.errorRate : null,
  }))
  const rates = rows.map((row) => row.errorRate)
  const clip = scale === "clip" ? clampedYMax(rates) : null
  if (clip != null && clip < 1) {
    return { rows, axis: { domain: [0, clip], allowDataOverflow: true }, clipMax: clip }
  }
  // Recharts turns a [0, 0] domain into ticks 0..4, which would read as 400%.
  const max = Math.max(0, ...rates.filter((rate): rate is number => rate != null))
  return { rows, axis: { domain: max > 0 ? [0, "auto"] : [0, 1] }, clipMax: null }
}
