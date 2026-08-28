/** Chip rules for the IP inspector. Pure so every threshold is unit-tested. */
import type { IpProfileBucketDto, IpProfileResponse } from "@/generated/api/types.gen"

export const SIGNAL_THRESHOLDS = {
  /** 4xx share that earns a chip, and the share that turns it red. */
  errorShareMin: 0.5,
  errorShareRed: 0.7,
  /** Below this many requests a high 4xx share means nothing. */
  errorShareMinRequests: 20,
  distinctPathsMin: 50,
  /** Peak bucket share of all requests that reads as a burst, with its floor. */
  burstShare: 0.5,
  burstMinRequests: 100,
} as const

export type SignalTone = "red" | "amber" | "gray"

export interface Signal {
  key: "errors" | "hosting" | "after-ban" | "paths" | "malformed" | "burst"
  label: string
  tone: SignalTone
}

/** Requests in buckets that start at or after `sinceIso`. Bucket
 *  resolution, so a ban mid-bucket under-counts by at most one bucket. */
export function requestsAfter(series: IpProfileBucketDto[], sinceIso: string): number {
  const since = Date.parse(sinceIso)
  return series.reduce((sum, b) => (Date.parse(b.timestamp) >= since ? sum + b.hits : sum), 0)
}

function hoursBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000))
}

/** Start of the bucket that contains `iso`, as the sparkline's category
 *  value. Recharts only draws a ReferenceLine whose x matches a data point. */
export function bucketFloor(iso: string, granularity: "hourly" | "daily"): string {
  const d = new Date(iso)
  d.setUTCMinutes(0, 0, 0)
  if (granularity === "daily") d.setUTCHours(0)
  return d.toISOString()
}

export function computeSignals({
  profile,
  banned,
  banCreatedAt,
}: {
  profile: IpProfileResponse
  banned: boolean
  banCreatedAt: string | null
}): Signal[] {
  const t = SIGNAL_THRESHOLDS
  const out: Signal[] = []
  const total = profile.totalRequests

  if (total >= t.errorShareMinRequests) {
    const share = profile.status4xx / total
    if (share >= t.errorShareMin) {
      out.push({
        key: "errors",
        label: `${Math.round(share * 100)}% 4xx`,
        tone: share >= t.errorShareRed ? "red" : "amber",
      })
    }
  }

  if (profile.asnCategory === "hosting") {
    out.push({ key: "hosting", label: "Hosting ASN", tone: "amber" })
  }

  if (banned && banCreatedAt && profile.lastSeen && Date.parse(profile.lastSeen) > Date.parse(banCreatedAt)) {
    const hours = hoursBetween(banCreatedAt, profile.lastSeen)
    const count = requestsAfter(profile.series, banCreatedAt)
    out.push({
      key: "after-ban",
      label: `Still seen ${hours}h after ban (${count} request${count === 1 ? "" : "s"})`,
      tone: "red",
    })
  }

  if (profile.distinctPaths >= t.distinctPathsMin) {
    out.push({ key: "paths", label: `${profile.distinctPaths} paths`, tone: "amber" })
  }

  if (profile.malformedRequests > 0) {
    out.push({ key: "malformed", label: `${profile.malformedRequests} malformed`, tone: "gray" })
  }

  if (profile.peak && total >= t.burstMinRequests && profile.peak.hits / total >= t.burstShare) {
    out.push({ key: "burst", label: "Burst", tone: "amber" })
  }

  return out
}
