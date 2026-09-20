/** Shaping helpers for the CrowdSec alert detail sheet. */
import type { AlertEventView } from "@/generated/api/types.gen"

/** Event meta keys the events table shows as their own columns. */
export const HTTP_EVENT_KEYS = ["http_verb", "http_path", "http_status", "http_user_agent", "target_fqdn"] as const

// Every event repeats these, and the sheet shows them once already.
const REDUNDANT_EVENT_KEYS = new Set(["timestamp", "source_ip"])

const CONTEXT_LABELS: Record<string, string> = {
  target_uri: "Targeted paths",
  user_agent: "User agents",
  method: "Methods",
  status: "Status codes",
  cve: "CVE",
}

export function hasHttpEvents(events: AlertEventView[]): boolean {
  return events.some((event) => "http_path" in event.meta)
}

/** Meta entries left over once the HTTP columns have taken theirs. */
export function eventExtras(meta: Record<string, string>, httpColumns: boolean): [string, string][] {
  const shown = new Set<string>(httpColumns ? HTTP_EVENT_KEYS : [])
  return Object.entries(meta)
    .filter(([key]) => !shown.has(key) && !REDUNDANT_EVENT_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
}

export function contextLabel(key: string): string {
  return CONTEXT_LABELS[key] ?? key
}

const GO_UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, "µs": 0.001, us: 0.001, ns: 0.000001 }

/** "9.693947574s" -> "9.7 s". Go prints durations to the nanosecond. */
export function formatGoDuration(value: string): string | null {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) return null
  const ms = parts.reduce((total, [, amount, unit]) => total + Number(amount) * GO_UNIT_MS[unit], 0)
  if (ms === 0) return "0 s"
  if (ms < 1) return "under 1 ms"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const OVERFLOW_MESSAGE = /^Ip (\S+) performed '.*' \((\d+) events over (\S+)\) at /

/** Rewrites CrowdSec's overflow message without the nanoseconds and the Go
 *  timestamp, which the sheet shows elsewhere. Other messages pass through. */
export function alertSummary(message: string): string {
  const match = OVERFLOW_MESSAGE.exec(message)
  if (!match) return message.replace(/^Ip /, "IP ")
  const [, ip, count, duration] = match
  const events = Number(count)
  const over = events > 1 ? formatGoDuration(duration) : null
  return `IP ${ip} triggered this scenario with ${events} ${events === 1 ? "event" : "events"}${over ? ` over ${over}` : ""}.`
}

const BLOCKLIST_ORIGINS = new Set(["CAPI", "lists"])

/** Whether the decision has an alert of its own to open. Blocklist
 *  decisions share one alert per pull, and the lookup goes by IP. */
export function decisionHasAlert(scope: string, decision: { id: number | null; origin: string }): boolean {
  return scope === "Ip" && decision.id !== null && !BLOCKLIST_ORIGINS.has(decision.origin)
}

/** "Telenor (AS2119)", or whichever half the LAPI has. */
export function asLabel(name: string | null, number: string | null): string | null {
  const as = number ? `AS${number}` : null
  if (name && as) return `${name} (${as})`
  return name ?? as
}
