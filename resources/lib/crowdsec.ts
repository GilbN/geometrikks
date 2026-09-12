/**
 * Shared CrowdSec UI constants and helpers: ban-duration choices and full
 * IP validation, used by the access-logs row actions, the map popup, and
 * the Security page's ban form.
 */
import { isAxiosError } from "axios"

/** Go duration strings the LAPI accepts; "Forever" is modeled as 10 years. */
export const BAN_DURATIONS = [
  { label: "1 hour", value: "1h" },
  { label: "4 hours", value: "4h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "168h" },
  { label: "Forever", value: "87600h" },
] as const

/** Full IPv4/IPv6 check. The backend validates against INET, so a partial
 * value (mid-typing) must never reach a request. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** The WHATWG URL parser implements the full IPv6 grammar (compressed and
 * IPv4-embedded forms), matching the backend's INET validation far more
 * faithfully than a hand-rolled regex. */
function isValidIpv6(value: string): boolean {
  if (!value.includes(":")) return false
  try {
    new URL(`http://[${value}]/`)
    return true
  } catch {
    return false
  }
}

export function isValidIp(value: string): boolean {
  return IPV4_RE.test(value) || isValidIpv6(value)
}

/** Human-readable message for a failed CrowdSec API call: the backend's
 * `detail` (e.g. "CrowdSec LAPI is unreachable") when present, else the
 * caller's fallback. */
export function crowdsecErrorMessage(err: unknown, fallback: string): string {
  const detail = isAxiosError(err)
    ? (err.response?.data as { detail?: string } | undefined)?.detail
    : null
  return detail ?? fallback
}

const DECISION_RANK = new Map<string, number>([["ban", 0], ["captcha", 1]])

function decisionRank(type: string): [number, string] {
  return [DECISION_RANK.get(type) ?? 2, type]
}

/** The type to show when an IP holds several decisions: ban, then captcha,
 *  then any bouncer-defined name in sorted order. Mirrors decision_winner
 *  in the backend. */
export function decisionWinner(current: string | null | undefined, candidate: string): string {
  if (current == null) return candidate
  const [currentRank, currentName] = decisionRank(current)
  const [candidateRank, candidateName] = decisionRank(candidate)
  if (currentRank !== candidateRank) return currentRank < candidateRank ? current : candidate
  return currentName <= candidateName ? current : candidate
}

/** The decision whose type wins under decisionWinner, or null when empty.
 *  On equal types the earlier decision stays, so the inspector header keeps
 *  showing the same scenario and expiry across refetches. */
export function winningDecision<T extends { type: string }>(decisions: readonly T[] | undefined): T | null {
  let winner: T | null = null
  for (const decision of decisions ?? []) {
    if (winner === null) {
      winner = decision
    } else if (decision.type !== winner.type && decisionWinner(winner.type, decision.type) === decision.type) {
      winner = decision
    }
  }
  return winner
}

/** The type to badge an IP with. A loaded map is authoritative: a missing
 *  entry means no decision, even when the caller knew one before, so an
 *  unban clears the badge. The caller's type only fills the gap while the
 *  map is still loading. */
export function resolveDecision(
  bannedIps: ReadonlyMap<string, string> | undefined,
  ip: string,
  initial: string | null,
): string | null {
  if (bannedIps === undefined) return initial
  return bannedIps.get(ip) ?? null
}

/** Badge text for a decision type; bouncer-defined names show as sent. */
export function decisionLabel(type: string): string {
  if (type === "ban") return "Banned"
  if (type === "captcha") return "Captcha"
  return type
}

/** Pill color inside the map popups, which render outside the stylesheet. */
export function decisionPopupColor(type: string): string {
  if (type === "ban") return "var(--destructive)"
  if (type === "captcha") return "#f59e0b"
  return "var(--popup-muted)"
}
