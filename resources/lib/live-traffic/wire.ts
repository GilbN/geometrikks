/**
 * Pure helpers for the timeline wire.
 *
 * The store keeps one bucket per second, but 300 one-second columns across a
 * ~700px canvas are sub-pixel hairlines. The wire therefore aggregates
 * consecutive seconds into display bins sized so every column is wide enough
 * to see and to hover. Bins are newest-aligned: the rightmost bin always ends
 * at "now", and any partial bin sits at the old left edge.
 *
 * Hover state is stored as a bin's start second, not its index - the window
 * shifts left every tick, so a cached index would silently point at a
 * different stretch of time a moment later.
 */
import { worseStatus } from "./classify"
import type { LiveRequest, SecondBucket, StatusClass } from "./types"

export interface WireBin {
  /** First second aggregated into this bin. */
  startSecond: number
  /** Seconds covered; the leftmost bin may cover fewer. */
  seconds: number
  total: number
  threats: number
  banned: number
  worstStatus: StatusClass
  /** Newest first, matching the per-bucket requestIds ordering. */
  requestIds: string[]
}

/** Minimum on-screen width of one bin column, gap included. */
const TARGET_COLUMN_PX = 5

/**
 * Seconds per display bin so each column is at least TARGET_COLUMN_PX wide.
 * A width too small to hold a single column collapses to one full-window bin.
 */
export function binSecondsFor(width: number, windowSeconds: number): number {
  const columns = Math.floor(width / TARGET_COLUMN_PX)
  if (columns < 1) return windowSeconds
  return Math.max(1, Math.ceil(windowSeconds / columns))
}

/** Aggregate one-second buckets into newest-aligned display bins. */
export function binBuckets(buckets: readonly SecondBucket[], binSeconds: number): WireBin[] {
  if (buckets.length === 0) return []
  const size = Math.max(1, binSeconds)
  const bins: WireBin[] = []
  const remainder = buckets.length % size
  let index = 0

  while (index < buckets.length) {
    const span = index === 0 && remainder > 0 ? remainder : size
    const chunk = buckets.slice(index, index + span)
    const bin: WireBin = {
      startSecond: chunk[0].second,
      seconds: span,
      total: 0,
      threats: 0,
      banned: 0,
      worstStatus: "unknown",
      requestIds: [],
    }
    // Walk the chunk newest-first so the bin's ids stay newest-first overall.
    for (let position = chunk.length - 1; position >= 0; position -= 1) {
      const bucket = chunk[position]
      bin.total += bucket.total
      bin.threats += bucket.threats
      bin.banned += bucket.banned
      bin.worstStatus = worseStatus(bin.worstStatus, bucket.worstStatus)
      bin.requestIds.push(...bucket.requestIds)
    }
    bins.push(bin)
    index += span
  }

  return bins
}

/**
 * Index of the bin containing the given second, or null when nothing is
 * hovered or that second has scrolled off the left edge.
 *
 * Containment, not equality: the window always holds a fixed number of
 * seconds, so bin boundaries shift by one second every tick and a stored
 * start second stops matching any bin almost immediately. The second under
 * the cursor, however, stays inside some bin until it ages out entirely.
 */
export function resolveHoveredBin(
  bins: readonly WireBin[],
  hoveredSecond: number | null,
): number | null {
  if (hoveredSecond === null) return null
  const index = bins.findIndex(
    (bin) => hoveredSecond >= bin.startSecond && hoveredSecond < bin.startSecond + bin.seconds,
  )
  return index === -1 ? null : index
}

/** The one request in a bin most worth showing: banned, then 4xx, then 5xx, then newest. */
export function notableRequest(
  bin: { requestIds: readonly string[] },
  lookup: (id: string) => LiveRequest | undefined,
): LiveRequest | undefined {
  const requests = bin.requestIds.map(lookup).filter((r): r is LiveRequest => r !== undefined)
  return (
    requests.find((r) => r.banned) ??
    requests.find((r) => r.statusClass === "4xx") ??
    requests.find((r) => r.statusClass === "5xx") ??
    requests[0]
  )
}
