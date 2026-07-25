/**
 * Aggregates over the live request buffer, shared by the desktop rail and the
 * phone sheet so both surfaces describe the window the same way.
 *
 * These read the buffer the store already keeps rather than adding counters
 * upstream: the window is at most a few thousand requests and both callers
 * only recompute once a second.
 */
import type { LiveRequest, StatusClass } from "./types"

/** Status classes in the order they read on the mix bar: healthy to worst. */
export const MIX_ORDER: StatusClass[] = ["2xx", "3xx", "4xx", "5xx", "unknown"]

export interface MixSlice {
  status: StatusClass
  count: number
  /** Share of the window, 0 to 1. */
  share: number
}

export interface OriginSlice {
  /** ISO country code, or "??" for requests with no GeoIP match. */
  country: string
  count: number
  /** Share of the busiest origin, 0 to 1, for the proportion bar. */
  share: number
}

export interface LiveSummary {
  total: number
  mix: MixSlice[]
  origins: OriginSlice[]
  threats: number
  /** Distinct banned IPs seen in the window, not the number of requests. */
  bannedIps: number
}

export const EMPTY_SUMMARY: LiveSummary = {
  total: 0,
  mix: [],
  origins: [],
  threats: 0,
  bannedIps: 0,
}

export function summarize(
  requests: readonly LiveRequest[],
  maxOrigins = 4,
): LiveSummary {
  if (requests.length === 0) return EMPTY_SUMMARY

  const byStatus = new Map<StatusClass, number>()
  const byCountry = new Map<string, number>()
  const banned = new Set<string>()
  let threats = 0

  for (const request of requests) {
    byStatus.set(request.statusClass, (byStatus.get(request.statusClass) ?? 0) + 1)
    const country = request.countryCode ?? "??"
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1)
    if (request.threat) threats += 1
    if (request.banned) banned.add(request.ip)
  }

  const total = requests.length
  const mix = MIX_ORDER.filter((status) => byStatus.has(status)).map((status) => {
    const count = byStatus.get(status) ?? 0
    return { status, count, share: count / total }
  })

  const ranked = [...byCountry.entries()].sort(
    // Count first, then code, so equal counts keep a stable order instead of
    // reshuffling every tick.
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  const peak = ranked[0]?.[1] ?? 1
  const origins = ranked.slice(0, maxOrigins).map(([country, count]) => ({
    country,
    count,
    share: count / peak,
  }))

  return { total, mix, origins, threats, bannedIps: banned.size }
}

/**
 * Second half of the sparkline against the first, as a percentage change.
 * Null when there is no earlier traffic to compare against, since "up from
 * nothing" is not a rate worth printing.
 */
export function trendPercent(sparkline: readonly number[]): number | null {
  if (sparkline.length < 4) return null
  const half = Math.floor(sparkline.length / 2)
  let earlier = 0
  let later = 0
  for (let index = 0; index < sparkline.length; index += 1) {
    if (index < half) earlier += sparkline[index]
    else later += sparkline[index]
  }
  if (earlier === 0) return null
  return Math.round(((later - earlier) / earlier) * 100)
}
