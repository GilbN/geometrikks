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
  bannedIps: ReadonlyMap<string, string>,
  receivedAt: number,
  index: number,
): LiveRequest {
  const ip = geo?.ip_address ?? log?.ip_address ?? ""
  const status = statusClass(log?.status_code)
  const decisionType = bannedIps.get(ip) ?? null
  const banned = decisionType !== null
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
    server: geo?.server ?? log?.server ?? null,
    statusClass: status,
    banned,
    decisionType,
    threat: isThreat(log?.status_code, banned),
  }
}

/** Exact-match server filter; empty selection means unfiltered. */
export function matchesServers(request: LiveRequest, servers: string[]): boolean {
  if (servers.length === 0) return true
  return request.server !== null && servers.includes(request.server)
}

export function toLiveRequests(
  events: LiveEvent[],
  bannedIps: ReadonlyMap<string, string>,
  receivedAt: number,
): LiveRequest[] {
  const requests: LiveRequest[] = []
  for (const event of events) {
    if (event.geo === null && event.log === null) continue
    requests.push(build(event.geo, event.log, bannedIps, receivedAt, requests.length))
  }
  return requests
}
