/**
 * Flatten live envelopes into whole requests.
 *
 * Each event is one committed record with its geo view and access-log view
 * already joined server-side. A geo view with no log still flies; a log
 * with no geo still appears in the feed.
 */
import type { LiveEvent } from "@/lib/websocket"
import { isThreat, statusClass } from "./classify"
import type { AccessLogData, GeoEventData, LiveRequest } from "./types"

function build(
  geo: GeoEventData | null,
  log: AccessLogData | null,
  bannedIps: ReadonlySet<string>,
  receivedAt: number,
  index: number,
): LiveRequest {
  const ip = geo?.ip_address ?? log?.ip_address ?? ""
  const status = statusClass(log?.status_code)
  const banned = bannedIps.has(ip)
  return {
    // receivedAt is the batch's arrival time and batches are at least
    // FLUSH_INTERVAL apart, so arrival plus position is unique.
    id: `${receivedAt}-${index}-${ip}`,
    timestamp: geo?.timestamp ?? log?.timestamp ?? "",
    receivedAt,
    ip,
    coordinates: geo ? [geo.longitude, geo.latitude] : null,
    city: geo?.city ?? log?.city ?? null,
    countryCode: geo?.country_code ?? log?.country_code ?? null,
    log,
    hostname: geo?.hostname ?? log?.hostname ?? null,
    statusClass: status,
    banned,
    threat: isThreat(log?.status_code, banned),
  }
}

/** Exact-match source filter; empty selection means unfiltered. */
export function matchesSources(request: LiveRequest, sources: string[]): boolean {
  if (sources.length === 0) return true
  return request.hostname !== null && sources.includes(request.hostname)
}

export function toLiveRequests(
  events: LiveEvent[],
  bannedIps: ReadonlySet<string>,
  receivedAt: number,
): LiveRequest[] {
  const requests: LiveRequest[] = []
  for (const event of events) {
    if (event.geo === null && event.log === null) continue
    requests.push(build(event.geo, event.log, bannedIps, receivedAt, requests.length))
  }
  return requests
}
