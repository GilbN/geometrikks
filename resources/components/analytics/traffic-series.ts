/** Rows, totals and x-axis ticks for the Analytics traffic charts. */
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { TimeSeriesResponse } from "@/lib/api"
import { formatTs } from "@/lib/datetime"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A week of hours is 169 buckets; a year is 8,785. Past this, draw the rows as they come. */
const MAX_FILLED_BUCKETS = 10_000

function emptyPoint(ms: number): TimeSeriesDataPoint {
  return {
    timestamp: new Date(ms).toISOString(),
    totalRequests: 0,
    totalBytesSent: 0,
    totalGeoEvents: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    errorRate: 0,
    timedRequests: 0,
    avgRequestTime: null,
    maxRequestTime: null,
    p50RequestTime: null,
    p95RequestTime: null,
    p99RequestTime: null,
  }
}

/**
 * The endpoint leaves out hours without traffic. On a time axis that would
 * pull the hours on either side together, so the missing hours go back in as
 * empty buckets. The grid follows the returned rows, which keeps half-hour
 * timezones on their own bucket edges. Past 30 days hourly rows may have
 * expired, so the grid starts at the first row instead of the range start.
 * Daily rows are returned as they are: their days are local days on one
 * rollup and UTC days on the other.
 */
export function fillHourlyGaps(response: TimeSeriesResponse): TimeSeriesDataPoint[] {
  const rows = response.data
  if (response.granularity !== "hourly" || rows.length === 0) return rows
  const startMs = Date.parse(response.startDate)
  const endMs = Date.parse(response.endDate)
  const firstMs = Date.parse(rows[0].timestamp)
  const lastMs = Date.parse(rows[rows.length - 1].timestamp)
  if ([startMs, endMs, firstMs, lastMs].some(Number.isNaN)) return rows

  const fromMs =
    endMs - startMs > 30 * DAY_MS
      ? firstMs
      : firstMs - Math.ceil((firstMs - startMs) / HOUR_MS) * HOUR_MS
  const toMs = lastMs + Math.max(0, Math.floor((endMs - lastMs) / HOUR_MS)) * HOUR_MS
  const count = Math.round((toMs - fromMs) / HOUR_MS) + 1
  if (count > MAX_FILLED_BUCKETS) return rows

  const byHour = new Map(rows.map((row) => [Date.parse(row.timestamp), row]))
  const filled: TimeSeriesDataPoint[] = []
  let placed = 0
  for (let index = 0; index < count; index++) {
    const ms = fromMs + index * HOUR_MS
    const row = byHour.get(ms)
    if (row) placed++
    filled.push(row ?? emptyPoint(ms))
  }
  // A row off the hour grid would be dropped, so draw the rows as sent instead.
  return placed === rows.length ? filled : rows
}

export type TrafficTotals = {
  totalRequests: number
  totalBytesSent: number
  status2xx: number
  status3xx: number
  status4xx: number
  status5xx: number
}

export function trafficTotals(rows: readonly TimeSeriesDataPoint[]): TrafficTotals {
  const totals: TrafficTotals = {
    totalRequests: 0,
    totalBytesSent: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
  }
  for (const row of rows) {
    for (const key of Object.keys(totals) as (keyof TrafficTotals)[]) totals[key] += row[key] ?? 0
  }
  return totals
}

/** Room each label needs on the axis, in pixels. */
const DAY_LABEL_PX = 64
/** A label centred closer than this to the plot's edge would run past it. */
const EDGE_PX = 14
const HOUR_LABEL_PX = 56

export type TimeTicks = { ticks: string[]; format: (timestamp: string) => string }

/**
 * Hourly x-axis labels. Above two days they sit at local midnight and read
 * the date, every day or every few days as the width allows. Up to two days
 * they mark every second or third hour (or fewer on a narrow chart) and read
 * the date at midnight. Daily buckets keep the axis' own labels (null).
 */
export function hourlyTicks(
  timestamps: readonly string[],
  granularity: string | undefined,
  plotWidth: number,
): TimeTicks | null {
  if (granularity !== "hourly" || timestamps.length === 0) return null
  const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
  const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { hour: "numeric" })
  const dates = timestamps.map((timestamp) => new Date(timestamp))
  const midnight = (date: Date) => date.getHours() === 0
  const fits = (labels: number, px: number) => labels * px <= Math.max(plotWidth, px)
  const clear = (index: number) => {
    const x = ((index + 0.5) / timestamps.length) * plotWidth
    return x > EDGE_PX && x < plotWidth - EDGE_PX
  }

  if (timestamps.length > 48) {
    const days = dates.filter(midnight).length
    const every =
      [1, 2, 3, 7, 14, 30].find((step) => fits(Math.ceil(days / step), DAY_LABEL_PX)) ?? 30
    let day = 0
    const ticks = timestamps.filter(
      (_, index) => midnight(dates[index]) && day++ % every === 0 && clear(index),
    )
    return { ticks, format: (timestamp) => DAY_LABEL.format(new Date(timestamp)) }
  }

  const steps = timestamps.length <= 14 ? [2, 3, 6, 12] : [3, 6, 12]
  const step =
    steps.find((hours) => fits(Math.ceil(timestamps.length / hours), HOUR_LABEL_PX)) ?? 12
  const ticks = timestamps.filter(
    (_, index) => dates[index].getHours() % step === 0 && clear(index),
  )
  return {
    ticks,
    format: (timestamp) => {
      const date = new Date(timestamp)
      return (midnight(date) ? DAY_LABEL : HOUR_LABEL).format(date)
    },
  }
}

/** "hourly from Nov 19, 11:00 PM to Nov 26, 10:00 PM", for a chart's screen reader summary. */
export function chartRangeText(
  rows: readonly { timestamp: string }[],
  granularity: string,
): string {
  if (rows.length === 0) return "no buckets"
  const size = granularity === "hourly" ? "hourly" : "daily"
  return `${size} from ${formatTs(rows[0].timestamp, granularity)} to ${formatTs(rows[rows.length - 1].timestamp, granularity)}`
}

/**
 * Byte axis ticks in whole steps of the unit the labels use (KB, MB, ...), so
 * they read 2.0 MB, 4.0 MB rather than 1.9 MB, 3.8 MB. `top` is the highest
 * value the axis must show: the clip line, or the largest bucket.
 */
export function byteTicks(top: number): { ticks: number[]; domain: [number, number] } {
  if (!(top > 0)) return { ticks: [0, 1024], domain: [0, 1024] }
  let unit = 1
  while (top / unit >= 1024 && unit < 1024 ** 4) unit *= 1024
  const scaled = top / unit
  const magnitude = 10 ** Math.floor(Math.log10(scaled / 4))
  const step =
    ([1, 2, 2.5, 5, 10].find((s) => scaled / 4 / magnitude <= s) ?? 10) * magnitude * unit
  const count = Math.ceil(top / step - 1e-9)
  const ticks = Array.from({ length: count + 1 }, (_, index) => index * step)
  return { ticks, domain: [0, ticks[ticks.length - 1]] }
}
