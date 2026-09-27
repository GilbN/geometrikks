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

/** Prefix length of a CIDR whose address part is a full IP, or null. Null
 *  for /0 too, which would ban every address, the operator's own included. */
function cidrPrefix(value: string): { prefix: number; bits: number } | null {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value)
  if (!match || !isValidIp(match[1]) || (match[2].length > 1 && match[2].startsWith("0"))) return null
  const bits = match[1].includes(":") ? 128 : 32
  const prefix = Number(match[2])
  return prefix >= 1 && prefix <= bits ? { prefix, bits } : null
}

/** An IP, or a range in CIDR form. The server bans a range on its network
 *  address, so host bits (203.0.113.9/24) are fine. */
export function isValidBanTarget(value: string): boolean {
  return isValidIp(value) || cidrPrefix(value) !== null
}

/** "256 addresses" for a range, null for a single address. IPv6 ranges past
 *  2^32 addresses read as a power of two. */
export function rangeSizeLabel(value: string): string | null {
  const cidr = cidrPrefix(value)
  if (cidr === null || cidr.prefix === cidr.bits) return null
  const hostBits = cidr.bits - cidr.prefix
  if (hostBits > 32) return `2^${hostBits} addresses`
  return `${new Intl.NumberFormat().format(2 ** hostBits)} addresses`
}

const BAN_DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

/** A duration the ban endpoint accepts: days, hours, minutes, seconds in
 *  that order, above zero. The server folds days into hours. */
export function isValidBanDuration(value: string): boolean {
  const match = BAN_DURATION_RE.exec(value)
  return match !== null && match.slice(1).some((part) => part !== undefined && Number(part) > 0)
}

export const DECISION_TYPES = [
  { label: "Ban", value: "ban" },
  { label: "Captcha", value: "captcha" },
] as const

export type BanDecisionType = (typeof DECISION_TYPES)[number]["value"]

export function crowdsecCtiUrl(ip: string): string {
  return `https://app.crowdsec.net/cti/${encodeURIComponent(ip)}`
}

// Hub WAF rules share these prefixes; everything else is a scenario.
const APPSEC_RULE_PREFIXES = ["vpatch-", "crs-", "appsec-"]

/** The Hub page for an author/name scenario, or null for our own manual
 *  decisions, blocklists and free-text scenarios. A custom local scenario
 *  still gets a link, and the Hub answers it with a 404. */
export function crowdsecHubUrl(scenario: string): string | null {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(scenario)
  if (!match || match[1] === "geometrikks") return null
  const [, author, name] = match
  const kind = APPSEC_RULE_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "appsec-rules" : "scenarios"
  return `https://app.crowdsec.net/hub/author/${author}/${kind}/${name}`
}

export function bgpAsUrl(asn: number | string | null | undefined): string | null {
  if (asn === null || asn === undefined || asn === "") return null
  return `https://bgp.he.net/AS${asn}`
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
