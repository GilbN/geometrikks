/**
 * Shapes for the joined live traffic stream.
 *
 * The socket emits one envelope per committed record with its geo and
 * access-log views already joined; a LiveRequest is that envelope
 * flattened, plus the classification the UI needs.
 */
import type { AccessLogData } from "@/lib/websocket"

export type { AccessLogData, GeoEventData } from "@/lib/websocket"

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
  /** Recording hostname (which instance/agent parsed it); null only for
   *  pre-upgrade events still in flight. */
  hostname: string | null
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
  /** Refused-or-banned requests in the window. See isThreat. */
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
