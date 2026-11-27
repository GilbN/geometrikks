/** Rows, totals and x-axis ticks for the Analytics traffic charts. */
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { TimeSeriesResponse } from "@/lib/api"
import { formatTs } from "@/lib/datetime"

const HOUR_MS = 3_600_000
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
 * timezones on their own bucket edges, and ends before the range's exclusive
 * end. Hours older than `keptSinceMs` may have expired, so a range that
 * starts before it begins at the first row instead of the range start.
 * Daily rows are returned as they are: their days are local days on one
 * rollup and UTC days on the other.
 */
export function fillHourlyGaps(
  response: TimeSeriesResponse,
  keptSinceMs: number,
  nowMs: number = Date.now(),
): TimeSeriesDataPoint[] {
  const rows = response.data
  if (response.granularity !== "hourly" || rows.length === 0) return rows
  const startMs = Date.parse(response.startDate)
  // Hours that have not happened yet are not empty; a custom range can end later today.
  const endMs = Math.min(Date.parse(response.endDate), nowMs)
  const firstMs = Date.parse(rows[0].timestamp)
  const lastMs = Date.parse(rows[rows.length - 1].timestamp)
  if ([startMs, endMs, firstMs, lastMs].some(Number.isNaN)) return rows

  const fromMs =
    startMs < keptSinceMs
      ? firstMs
      : firstMs - Math.max(0, Math.ceil((firstMs - startMs) / HOUR_MS)) * HOUR_MS
  const toMs = lastMs + Math.max(0, Math.ceil((endMs - lastMs) / HOUR_MS) - 1) * HOUR_MS
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
const DAY_LABEL_PX = 56
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
  const HOUR_MINUTE_LABEL = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  const dates = timestamps.map((timestamp) => new Date(timestamp))
  // The first bucket of each local date. Usually midnight, but daylight saving can skip
  // midnight, and in a half-hour timezone the day starts at the 00:30 bucket.
  const dayStart = (index: number) =>
    index === 0 ? dates[0].getHours() === 0 : dates[index].getDate() !== dates[index - 1].getDate()
  const dayStarts = new Set(timestamps.filter((_, index) => dayStart(index)))
  // When daylight saving ends, the repeated hour gets one label.
  const repeat = (index: number) =>
    index > 0 &&
    dates[index - 1].getHours() === dates[index].getHours() &&
    dates[index - 1].getDate() === dates[index].getDate()
  const fits = (labels: number, px: number) => labels * px <= Math.max(plotWidth, px)
  const clear = (index: number) => {
    const x = ((index + 0.5) / timestamps.length) * plotWidth
    return x > EDGE_PX && x < plotWidth - EDGE_PX
  }

  // Two days of hours span 49 buckets, or 50 across the end of daylight saving.
  if (timestamps.length > 50) {
    const days = dayStarts.size
    const every =
      [1, 2, 3, 7, 14, 30].find((step) => fits(Math.ceil(days / step), DAY_LABEL_PX)) ??
      Math.ceil((days * DAY_LABEL_PX) / Math.max(plotWidth, DAY_LABEL_PX))
    let day = 0
    const ticks = timestamps.filter(
      (_, index) => dayStart(index) && day++ % every === 0 && clear(index),
    )
    return { ticks, format: (timestamp) => DAY_LABEL.format(new Date(timestamp)) }
  }

  const steps = timestamps.length <= 14 ? [2, 3, 6, 12] : [3, 6, 12]
  const step =
    steps.find((hours) => fits(Math.ceil(timestamps.length / hours), HOUR_LABEL_PX)) ?? 12
  const marked = timestamps.filter(
    (_, index) =>
      (dayStart(index) || (dates[index].getHours() % step === 0 && !repeat(index))) && clear(index),
  )
  // A range of a few minutes can sit inside one odd hour, which no step marks.
  const ticks = marked.length > 0 ? marked : timestamps.slice(0, 1)
  return {
    ticks,
    format: (timestamp) => {
      const date = new Date(timestamp)
      if (dayStarts.has(timestamp)) return DAY_LABEL.format(date)
      // Buckets in a half-hour timezone start at :30 local time.
      return (date.getMinutes() === 0 ? HOUR_LABEL : HOUR_MINUTE_LABEL).format(date)
    },
  }
}

/**
 * "since Sep 28" when an hourly series starts later than the range, because
 * the older hours have expired; the totals then cover only what is drawn.
 */
export function hoursSince(
  rows: readonly { timestamp: string }[],
  startDate: string | undefined,
  granularity: string | undefined,
): string | null {
  if (granularity !== "hourly" || rows.length === 0 || !startDate) return null
  const first = Date.parse(rows[0].timestamp)
  return first - Date.parse(startDate) > HOUR_MS ? `since ${formatTs(first, "daily")}` : null
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
  const nice = [1, 2, 2.5, 5, 10].find((s) => scaled / 4 / magnitude <= s) ?? 10
  // Labels show whole bytes, so a step under 1 B would repeat them.
  const step = Math.max(nice * magnitude * unit, 1)
  const count = Math.ceil(top / step - 1e-9)
  const ticks = Array.from({ length: count + 1 }, (_, index) => index * step)
  return { ticks, domain: [0, ticks[ticks.length - 1]] }
}

export type DragSelection = {
  /** Start of the first selected bucket, or of the page's range when that starts later. */
  startMs: number
  /** Exclusive end of the last selected bucket, or of the page's range when that ends sooner. */
  endMs: number
  /** Buckets the drag covers. */
  buckets: number
  /** Indexes of the first and last covered bucket. */
  first: number
  last: number
  /** True when the page's range cuts into the first or last bucket. */
  clipped: boolean
}

/**
 * Where a bucket ends. Hourly buckets last an hour and UTC days a day.
 * A local day ends at the next row when that is the next day (23 to 25 hours
 * on, for daylight saving), otherwise, with a quiet day after it, at the next
 * local midnight.
 */
export function bucketEndMs(
  times: readonly number[],
  index: number,
  granularity: string | undefined,
  utcDays = false,
): number {
  const start = times[index]
  if (granularity === "hourly") return start + HOUR_MS
  if (utcDays) return start + 24 * HOUR_MS
  const next = times[index + 1]
  if (next != null && next - start >= 23 * HOUR_MS && next - start <= 25 * HOUR_MS) return next
  const date = new Date(start)
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  return start + 24 * HOUR_MS
}

/**
 * The time a drag from bucket `fromMs` to bucket `toMs` selects, inside the
 * page's range. `utcDays` says the daily buckets are UTC days, as the server
 * sends for unfiltered ranges over 30 days.
 */
export function dragSelection(
  times: readonly number[],
  fromMs: number,
  toMs: number,
  granularity: string | undefined,
  range: { startMs: number; endMs: number },
  utcDays = false,
): DragSelection | null {
  // By bounds, not exact times: a refetch mid-drag can drop the bucket the drag started on.
  const first = times.findIndex((ms) => ms >= fromMs)
  let last = times.length - 1
  while (last >= 0 && times[last] > toMs) last--
  if (first < 0 || last < first) return null
  const bucketEnd = bucketEndMs(times, last, granularity, utcDays)
  const startMs = Math.max(times[first], range.startMs)
  const endMs = Math.min(bucketEnd, range.endMs)
  return {
    startMs,
    endMs,
    buckets: last - first + 1,
    first,
    last,
    clipped: startMs > times[first] || endMs < bucketEnd,
  }
}
