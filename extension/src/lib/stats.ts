import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"

const HOUR_MS = 60 * 60_000

export function summarize(points: TimeSeriesDataPoint[]): {
  requests: number
  errors: number
  bytes: number
  errorRate: number | null
} {
  let requests = 0
  let errors = 0
  let bytes = 0
  for (const point of points) {
    requests += point.totalRequests
    errors += point.status4xx + point.status5xx
    bytes += point.totalBytesSent
  }
  return { requests, errors, bytes, errorRate: requests > 0 ? errors / requests : null }
}

export interface HourBucket {
  start: Date
  requests: number
  errors: number
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}

/** One bucket per UTC hour that overlaps `[start, end)`; the endpoint
 *  leaves out hours with no traffic. */
export function zeroFillHourly(
  points: TimeSeriesDataPoint[],
  start: Date,
  end: Date,
): HourBucket[] {
  const first = floorHour(start.getTime())
  const buckets: HourBucket[] = []
  for (let at = first; at < end.getTime(); at += HOUR_MS)
    buckets.push({ start: new Date(at), requests: 0, errors: 0 })
  for (const point of points) {
    const bucket = buckets[(floorHour(Date.parse(point.timestamp)) - first) / HOUR_MS]
    if (!bucket) continue
    bucket.requests += point.totalRequests
    bucket.errors += point.status4xx + point.status5xx
  }
  return buckets
}

/** Sums hourly buckets into local 00, 06, 12 and 18 o'clock blocks. */
export function toSixHour(buckets: HourBucket[]): HourBucket[] {
  const blocks = new Map<number, HourBucket>()
  for (const bucket of buckets) {
    const { start } = bucket
    const blockStart = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      Math.floor(start.getHours() / 6) * 6,
    )
    const key = blockStart.getTime()
    const block = blocks.get(key) ?? { start: blockStart, requests: 0, errors: 0 }
    block.requests += bucket.requests
    block.errors += bucket.errors
    blocks.set(key, block)
  }
  return [...blocks.values()].sort((a, b) => a.start.getTime() - b.start.getTime())
}
