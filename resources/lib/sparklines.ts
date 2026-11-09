import type { GeoEventsTimeSeriesResponse, TimeSeriesResponse } from "@/lib/api"
import type { GeoLogTimeSeriesResponse } from "@/generated/api/types.gen"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** With fewer buckets the line is a few straight segments, not a shape. */
export const MIN_SPARKLINE_BUCKETS = 6

/** Hourly up to a week (168 points at most), daily above. */
export function sparklineGranularity(startMs: number, endMs: number): "hourly" | "daily" {
  return endMs - startMs <= 7 * DAY_MS + HOUR_MS ? "hourly" : "daily"
}

export function hasSparklines(
  startMs: number,
  endMs: number,
  granularity: "hourly" | "daily" = sparklineGranularity(startMs, endMs),
): boolean {
  const step = granularity === "hourly" ? HOUR_MS : DAY_MS
  return Math.ceil((endMs - startMs) / step) >= MIN_SPARKLINE_BUCKETS
}

/**
 * The series endpoints leave out buckets without traffic, which would draw a
 * quiet night as a straight line between its edges. Zeros go back in from
 * the gaps between returned buckets rather than from a grid built on the
 * client, because daily buckets are local days on the hourly aggregate and
 * UTC days on the daily one.
 */
export function fillGaps(
  points: readonly { timestamp: string; value: number }[],
  startMs: number,
  endMs: number,
  stepMs: number,
): number[] {
  const zeros = (count: number) => Array<number>(Math.max(0, count)).fill(0)
  if (points.length === 0) return zeros(Math.ceil((endMs - startMs) / stepMs))

  // A local day can run 23 or 25 hours, so the edges allow a little slack.
  const bucketsBetween = (fromMs: number, toMs: number) => Math.ceil((toMs - fromMs) / stepMs - 0.05)
  const times = points.map((point) => Date.parse(point.timestamp))
  const filled = zeros(bucketsBetween(startMs, times[0]))
  points.forEach((point, index) => {
    if (index > 0) filled.push(...zeros(Math.round((times[index] - times[index - 1]) / stepMs) - 1))
    filled.push(point.value)
  })
  filled.push(...zeros(bucketsBetween(times[times.length - 1], endMs) - 1))
  return filled
}

/**
 * Past 30 days a card's total reads the daily rollup, and hourly rows may have
 * expired. An hourly line there starts at its first row, or the expired part
 * would read as no traffic under a total that counts it.
 */
function lineStartMs(rows: readonly { timestamp: string }[], step: number, startMs: number, endMs: number): number {
  if (step !== HOUR_MS || endMs - startMs <= 30 * DAY_MS) return startMs
  return rows.length > 0 ? Date.parse(rows[0].timestamp) : endMs
}

/**
 * A page's card charts. `drawable` is false when the range is too short to
 * draw a shape, and `shown` is also false while charts are off. `drawKey`
 * names the data the lines belong to and changes when that data's lines
 * arrive, not when it is picked.
 */
export interface CardSparklines<Lines> {
  shown: boolean
  drawable: boolean
  lines: Lines | undefined
  drawKey: string
}

export interface OverviewSparklines {
  requests: number[]
  geoEvents: number[]
  uniqueCountries: number[]
  uniqueIps: number[]
  /** 2xx share of each bucket's requests, since the Success card shows a percentage. */
  successRate: number[]
  status3xx: number[]
  status4xx: number[]
  status5xx: number[]
  bytesSent: number[]
  avgRequestTime: number[]
  maxRequestTime: number[]
  avgRequestSize: number[]
}

/**
 * Counts get their empty buckets back as zeros. Rates, averages and maxima
 * have no value in an empty bucket, and a zero there would read as an outage
 * or instant responses, so those lines skip the bucket instead.
 */
export function buildOverviewSparklines(
  timeSeries: TimeSeriesResponse | undefined,
  geoSeries: GeoEventsTimeSeriesResponse | undefined,
  startMs: number,
  endMs: number,
): OverviewSparklines {
  const step = (timeSeries?.granularity ?? geoSeries?.granularity) === "daily" ? DAY_MS : HOUR_MS
  const access = timeSeries?.data ?? []
  const geo = geoSeries?.data ?? []
  const counts = <T extends { timestamp: string }>(rows: readonly T[], pick: (row: T) => number) =>
    fillGaps(
      rows.map((row) => ({ timestamp: row.timestamp, value: pick(row) })),
      lineStartMs(rows, step, startMs, endMs),
      endMs,
      step,
    )
  const present = (pick: (row: (typeof access)[number]) => number | null | undefined) =>
    access.flatMap((row) => {
      const value = pick(row)
      return value == null ? [] : [value]
    })

  return {
    requests: counts(access, (row) => row.totalRequests),
    geoEvents: counts(geo, (row) => row.totalGeoEvents),
    uniqueCountries: counts(geo, (row) => row.uniqueCountries),
    uniqueIps: counts(geo, (row) => row.uniqueIps),
    status3xx: counts(access, (row) => row.status3xx),
    status4xx: counts(access, (row) => row.status4xx),
    status5xx: counts(access, (row) => row.status5xx),
    bytesSent: counts(access, (row) => row.totalBytesSent),
    successRate: present((row) => (row.totalRequests > 0 ? row.status2xx / row.totalRequests : null)),
    avgRequestTime: present((row) => row.avgRequestTime),
    maxRequestTime: present((row) => row.maxRequestTime),
    avgRequestSize: present((row) => (row.totalRequests > 0 ? row.totalBytesSent / row.totalRequests : null)),
  }
}

export interface GeoLogSparklines {
  events: number[]
  uniqueIps: number[]
  uniqueCountries: number[]
  uniqueCities: number[]
}

export function buildGeoLogSparklines(
  series: GeoLogTimeSeriesResponse | undefined,
  startMs: number,
  endMs: number,
): GeoLogSparklines {
  const step = series?.granularity === "daily" ? DAY_MS : HOUR_MS
  const rows = series?.data ?? []
  const counts = (pick: (row: (typeof rows)[number]) => number) =>
    fillGaps(rows.map((row) => ({ timestamp: row.timestamp, value: pick(row) })), lineStartMs(rows, step, startMs, endMs), endMs, step)
  return {
    events: counts((row) => row.totalEvents),
    uniqueIps: counts((row) => row.uniqueIps),
    uniqueCountries: counts((row) => row.uniqueCountries),
    uniqueCities: counts((row) => row.uniqueCities),
  }
}

/** Reads the window from the response, since these lines can be another range's placeholder data. */
export function geoLogSparklinesFromSeries(series: GeoLogTimeSeriesResponse): GeoLogSparklines {
  return buildGeoLogSparklines(series, Date.parse(series.startDate), Date.parse(series.endDate))
}
