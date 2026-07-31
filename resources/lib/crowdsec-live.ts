/**
 * Wire contract and pure cache-patch helpers for the /ws/crowdsec feed.
 * Kept free of React/query imports so vitest can cover the frame handling
 * that useCrowdsecLiveUpdates wires into the query cache.
 */
import type { CrowdSecStatusResponse } from "@/generated/api/types.gen"

/** Ban/unban delta pushed by the decision-stream poller. */
export interface CrowdsecDecisionsFrame {
  type: "crowdsec_decisions"
  added: { ip: string; origin: string; scenario: string; duration: string }[]
  deleted: { ip: string; origin: string }[]
}

/** LAPI reachability transition; also sent once as a snapshot on connect. */
export interface CrowdsecStatusFrame {
  type: "crowdsec_status"
  lapi_reachable: boolean
}

export type CrowdsecFrame = CrowdsecDecisionsFrame | CrowdsecStatusFrame

/** Parse one raw WS message; null for non-JSON payloads or unknown types. */
export function parseCrowdsecFrame(data: unknown): CrowdsecFrame | null {
  if (typeof data !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const frame = parsed as { type?: string }
  if (frame.type === "crowdsec_decisions" || frame.type === "crowdsec_status") {
    return frame as CrowdsecFrame
  }
  return null
}

/** Apply a decisions delta to the cached banned-IP list. */
export function applyBannedIpsDelta(
  ips: string[] | undefined,
  frame: CrowdsecDecisionsFrame,
): string[] | undefined {
  if (!ips) return ips
  const next = new Set(ips)
  for (const d of frame.added) next.add(d.ip)
  for (const d of frame.deleted) next.delete(d.ip)
  return [...next]
}

/** Patch the cached /crowdsec/status query with a pushed reachability change. */
export function applyStatusFrame(
  status: CrowdSecStatusResponse | undefined,
  frame: CrowdsecStatusFrame,
): CrowdSecStatusResponse | undefined {
  if (!status) return status
  return { ...status, lapi_reachable: frame.lapi_reachable }
}
