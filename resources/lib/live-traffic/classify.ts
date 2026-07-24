/**
 * Classification for live requests: what class of answer was this, does it
 * belong in the threat lane, and how should its packet look.
 */
import type { StatusClass } from "./types"

export const PACKET_COLORS: Record<StatusClass, string> = {
  "2xx": "#34d399",
  "3xx": "#38bdf8",
  "4xx": "#fbbf24",
  "5xx": "#f87171",
  // A geo event with no paired log line: we know where, not what.
  unknown: "#22d3ee",
}

/** The cage ring drawn over a banned IP's packet, matching the banned overlay. */
export const BANNED_RING_COLOR = "#ef4444"

const MIN_RADIUS = 3
const MAX_RADIUS = 7
/** Bytes at which a packet reaches full size. */
const RADIUS_CEILING_BYTES = 1_000_000

export function statusClass(code: number | null | undefined): StatusClass {
  if (typeof code !== "number") return "unknown"
  if (code >= 200 && code < 300) return "2xx"
  if (code >= 300 && code < 400) return "3xx"
  if (code >= 400 && code < 500) return "4xx"
  if (code >= 500 && code < 600) return "5xx"
  return "unknown"
}

/**
 * A threat is someone poking at the server: a 4xx, or anything at all from an
 * IP CrowdSec has banned. A 5xx is the server's own failure and belongs in the
 * error rate, not the threat lane.
 */
export function isThreat(status: StatusClass, banned: boolean): boolean {
  return banned || status === "4xx"
}

export function packetColor(status: StatusClass): string {
  return PACKET_COLORS[status]
}

/** Log-scaled so a 40 MB download does not dwarf every other packet. */
export function packetRadius(bytes: number | null | undefined): number {
  if (typeof bytes !== "number" || bytes <= 0) return MIN_RADIUS
  const scale = Math.log10(bytes + 1) / Math.log10(RADIUS_CEILING_BYTES + 1)
  const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scale
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Number(radius.toFixed(2))))
}

const SEVERITY: Record<StatusClass, number> = {
  unknown: 0,
  "2xx": 1,
  "3xx": 2,
  "4xx": 3,
  "5xx": 4,
}

export function worseStatus(a: StatusClass, b: StatusClass): StatusClass {
  return SEVERITY[b] > SEVERITY[a] ? b : a
}
