/**
 * Wire contract and pure cache-patch helpers for the /ws/crowdsec feed.
 * Kept free of React/query imports so vitest can cover the frame handling
 * that useCrowdsecLiveUpdates wires into the query cache.
 */
import type { BannedIp, CrowdSecStatusResponse } from "@/generated/api/types.gen"
import { decisionWinner } from "@/lib/crowdsec"

/** Decision delta pushed by the decision-stream poller; every entry carries
 *  its decision type. */
export interface CrowdsecDecisionsFrame {
  type: "crowdsec_decisions"
  added: { ip: string; type: string; origin: string; scenario: string; duration: string }[]
  deleted: { ip: string; type: string; origin: string }[]
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

/** Apply a decisions delta to the cached banned-IP entries. Deletions run before
 *  additions, so a frame that deletes an IP's expiring decision and adds its
 *  replacement in the same delta still keeps the IP badged; add-first would let
 *  the add absorb into the stored decision and the delete would then remove it.
 *  An added decision never weakens the shown type; a deleted one only clears
 *  the IP when it is the type shown. The burst refetch settles anything this
 *  cannot know, such as a second ban surviving the deleted one. */
export function applyBannedIpsDelta(
  ips: BannedIp[] | undefined,
  frame: CrowdsecDecisionsFrame,
): BannedIp[] | undefined {
  if (!ips) return ips
  const next = new Map(ips.map((entry) => [entry.ip, entry.type]))
  for (const d of frame.deleted) if (next.get(d.ip) === d.type) next.delete(d.ip)
  for (const d of frame.added) next.set(d.ip, decisionWinner(next.get(d.ip), d.type))
  return [...next].map(([ip, type]) => ({ ip, type }))
}

/** Patch the cached /crowdsec/status query with a pushed reachability change. */
export function applyStatusFrame(
  status: CrowdSecStatusResponse | undefined,
  frame: CrowdsecStatusFrame,
): CrowdSecStatusResponse | undefined {
  if (!status) return status
  return { ...status, lapiReachable: frame.lapi_reachable }
}
