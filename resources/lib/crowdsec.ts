/**
 * Shared CrowdSec UI constants and helpers: ban-duration choices and full
 * IP validation, used by the access-logs row actions, the map popup, and
 * the Security page's ban form.
 */

/** Go duration strings the LAPI accepts; "Forever" is modeled as 10 years. */
export const BAN_DURATIONS = [
  { label: "1 hour", value: "1h" },
  { label: "4 hours", value: "4h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "168h" },
  { label: "Forever", value: "87600h" },
] as const

/** Full IPv4/IPv6 check — the backend validates against INET, so a partial
 * value (mid-typing) must never reach a request. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_RE =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:)*:([0-9a-f]{1,4}:)*[0-9a-f]{0,4})$/i

export function isValidIp(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(":") && IPV6_RE.test(value))
}
