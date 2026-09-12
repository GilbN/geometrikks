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

export interface DecisionCounts {
  ban: number
  captcha: number
  /** Bouncer-defined remediation names, folded together. */
  other: number
}

export interface LiveSummary {
  total: number
  mix: MixSlice[]
  origins: OriginSlice[]
  threats: number
  /** Distinct IPs under a decision seen in the window, per type; not the
   *  number of requests. */
  decisions: DecisionCounts
}

export const EMPTY_SUMMARY: LiveSummary = {
  total: 0,
  mix: [],
  origins: [],
  threats: 0,
  decisions: { ban: 0, captcha: 0, other: 0 },
}

export function summarize(
  requests: readonly LiveRequest[],
  maxOrigins = 4,
): LiveSummary {
  if (requests.length === 0) return EMPTY_SUMMARY

  const byStatus = new Map<StatusClass, number>()
  const byCountry = new Map<string, number>()
  const decided = new Map<string, { type: string; receivedAt: number }>()
  let threats = 0

  for (const request of requests) {
    byStatus.set(request.statusClass, (byStatus.get(request.statusClass) ?? 0) + 1)
    const country = request.countryCode ?? "??"
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1)
    if (request.threat) threats += 1
    if (request.decisionType !== null) {
      // Each request carries the badge map as it stood on arrival, so an
      // IP whose decision changed inside the window counts under the type
      // on its newest request, whichever order the buffer holds them in.
      const known = decided.get(request.ip)
      if (known === undefined || request.receivedAt > known.receivedAt) {
        decided.set(request.ip, { type: request.decisionType, receivedAt: request.receivedAt })
      }
    }
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

  const decisions: DecisionCounts = { ban: 0, captcha: 0, other: 0 }
  for (const { type } of decided.values()) {
    if (type === "ban") decisions.ban += 1
    else if (type === "captcha") decisions.captcha += 1
    else decisions.other += 1
  }

  return { total, mix, origins, threats, decisions }
}

/** "Banned 3 IPs · Captcha 1 IP", non-zero types only; null when none. */
export function describeDecisions(counts: DecisionCounts): string | null {
  const parts = (
    [
      ["Banned", counts.ban],
      ["Captcha", counts.captcha],
      ["Other decisions", counts.other],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count.toLocaleString()} ${count === 1 ? "IP" : "IPs"}`)
  return parts.length ? parts.join(" · ") : null
}

/**
 * Too few requests in the earlier half to divide by honestly. Below this a
 * couple of arrivals read as several hundred percent, which is arithmetic
 * rather than information - and it is exactly what a freshly opened page
 * sees while the window fills.
 */
const MIN_TREND_BASELINE = 5

/**
 * Second half of the sparkline against the first, as a percentage change,
 * rounded to the nearest 5. Null when the earlier half is too thin to compare
 * against.
 *
 * The rounding is what keeps the reading still: traffic arriving in bursts
 * swings the exact figure by a point or two every second, which reads as a
 * flickering badge rather than as information.
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
  if (earlier < MIN_TREND_BASELINE) return null
  return Math.round(((later - earlier) / earlier) * 20) * 5
}

/**
 * Centred moving average, for display only.
 *
 * The buckets behind the sparkline count one second each, and traffic does
 * not arrive one request per second - it arrives in bursts, so the raw series
 * is a comb of spikes and zeroes that says nothing about the rhythm. Averaging
 * over a few seconds shows the shape the spikes are made of. Edge samples
 * average over the window they have.
 */
export function smooth(values: readonly number[], window = 5): number[] {
  if (window <= 1 || values.length === 0) return [...values]
  const half = Math.floor(window / 2)
  const smoothed: number[] = []

  for (let index = 0; index < values.length; index += 1) {
    const from = Math.max(0, index - half)
    const to = Math.min(values.length - 1, index + half)
    let sum = 0
    for (let sample = from; sample <= to; sample += 1) sum += values[sample]
    smoothed.push(sum / (to - from + 1))
  }

  return smoothed
}
