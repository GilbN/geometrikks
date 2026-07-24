/**
 * Zip a live batch back into whole requests.
 *
 * record_to_events() emits the geo event first and the access log second for
 * one committed record, so a single forward pass with one lookahead recovers
 * the pairing. Anything that does not pair is kept on its own: a geo event
 * with no log still flies, a log with no geo still appears in the feed.
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
    statusClass: status,
    banned,
    threat: isThreat(status, banned),
  }
}

export function pairLiveEvents(
  events: LiveEvent[],
  bannedIps: ReadonlySet<string>,
  receivedAt: number,
): LiveRequest[] {
  const requests: LiveRequest[] = []
  let index = 0

  while (index < events.length) {
    const event = events[index]
    const next = events[index + 1]
    const pairs =
      event.type === "geo_event" &&
      next?.type === "access_log" &&
      next.data.ip_address === event.data.ip_address &&
      next.data.timestamp === event.data.timestamp

    if (pairs && next.type === "access_log" && event.type === "geo_event") {
      requests.push(build(event.data, next.data, bannedIps, receivedAt, requests.length))
      index += 2
      continue
    }

    requests.push(
      event.type === "geo_event"
        ? build(event.data, null, bannedIps, receivedAt, requests.length)
        : build(null, event.data, bannedIps, receivedAt, requests.length),
    )
    index += 1
  }

  return requests
}
