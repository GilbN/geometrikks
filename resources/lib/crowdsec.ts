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
