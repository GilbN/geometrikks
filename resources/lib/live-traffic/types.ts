/**
 * Shapes for the joined live traffic stream.
 *
 * The socket emits a geo_event and an access_log for the same committed
 * record; a LiveRequest is the two of them zipped back together, plus the
 * classification the UI needs.
 */
import type { LiveEvent } from "@/lib/websocket"

export type AccessLogData = Extract<LiveEvent, { type: "access_log" }>["data"]
export type GeoEventData = Extract<LiveEvent, { type: "geo_event" }>["data"]

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "unknown"

export interface LiveRequest {
  /** Stable for the lifetime of the buffer; used by popups and replay. */
  id: string
  /** Server-side timestamp from the log line. */
  timestamp: string
  /** Client clock at arrival. Drives bucketing and eviction, never display. */
  receivedAt: number
  ip: string
  /** Null when the log line had no GeoIP match; such a request never flies. */
  coordinates: [longitude: number, latitude: number] | null
  city: string | null
  countryCode: string | null
  /** Null for a geo event with no paired access_log. */
  log: AccessLogData | null
  statusClass: StatusClass
  banned: boolean
  threat: boolean
}

export interface SecondBucket {
  /** Epoch seconds. */
  second: number
  total: number
  threats: number
  banned: number
  worstStatus: StatusClass
  requestIds: string[]
}

export interface Vitals {
  /** Requests in the last 60 seconds. */
  rpm: number
  /** 5xx share of the window, 0 to 1. */
  errorRate: number
  /** 4xx-or-banned requests in the window. */
  threatCount: number
  uniqueIps: number
  countries: number
  /** Events the server discarded because the frame was full. */
  dropped: number
  /** A drop occurred within the last RECENT_DROP_MS. */
  droppedRecently: boolean
  /** Requests per second for the last 60 seconds, oldest first. */
  sparkline: number[]
}
