import type { ApiKeyList, ApiKeyView } from "@/generated/api/types.gen"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LIVE_WITHIN_MS = DAY_MS
const STALE_AFTER_MS = 30 * DAY_MS

export const API_KEY_NAME_MAX_LENGTH = 64

export type ApiKeyScope = ApiKeyView["scope"]

/** live: used in the last day. stale: never used and older than 30 days. */
export type UsageTone = "live" | "idle" | "stale"

export type ExpiryChoice = "never" | "30d" | "90d" | "1y" | "date"

export const EXPIRY_CHOICES: { value: ExpiryChoice; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "date", label: "Custom date" },
]

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`

export function timeAgo(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return "just now"
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)} min ago`
  if (elapsedMs < DAY_MS) return plural(Math.floor(elapsedMs / HOUR_MS), "hour")
  const days = Math.floor(elapsedMs / DAY_MS)
  if (days < 14) return plural(days, "day")
  if (days < 60) return plural(Math.floor(days / 7), "week")
  if (days < 365) return plural(Math.floor(days / 30), "month")
  return plural(Math.floor(days / 365), "year")
}

export function usageTone(apiKey: ApiKeyView, now: number): UsageTone {
  if (apiKey.lastUsedAt) return now - Date.parse(apiKey.lastUsedAt) < LIVE_WITHIN_MS ? "live" : "idle"
  return now - Date.parse(apiKey.createdAt) > STALE_AFTER_MS ? "stale" : "idle"
}

export function lastUsedLabel(apiKey: ApiKeyView, now: number): string {
  if (apiKey.lastUsedAt) return `Used ${timeAgo(now - Date.parse(apiKey.lastUsedAt))}`
  if (usageTone(apiKey, now) === "stale") return `Never used, created ${timeAgo(now - Date.parse(apiKey.createdAt))}`
  return "Never used"
}

/** What the Last used cell's tooltip adds: the IP, or why a never-used key is flagged. */
export function lastUsedDetail(apiKey: ApiKeyView, now: number): string | null {
  if (apiKey.lastUsedIp) return `${lastUsedLabel(apiKey, now)} from ${apiKey.lastUsedIp}`
  if (usageTone(apiKey, now) === "stale") return lastUsedLabel(apiKey, now)
  return null
}

export function lastUsedShort(apiKey: ApiKeyView, now: number): string {
  return apiKey.lastUsedAt ? timeAgo(now - Date.parse(apiKey.lastUsedAt)) : "Never"
}

export function formatKeyDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

export function expiryLabel(apiKey: ApiKeyView): string {
  if (!apiKey.expiresAt) return "Never expires"
  return `${apiKey.expired ? "Expired" : "Expires"} ${formatKeyDate(apiKey.expiresAt)}`
}

export function expiryShort(apiKey: ApiKeyView): string {
  return apiKey.expiresAt ? formatKeyDate(apiKey.expiresAt) : "Never"
}

/** The instant to send as `expiresAt`. A picked date lasts to the end of that day in the browser's timezone. */
export function expiresAtFor(choice: ExpiryChoice, picked: Date | undefined, now: Date): string | null {
  switch (choice) {
    case "never":
      return null
    case "30d":
      return new Date(now.getTime() + 30 * DAY_MS).toISOString()
    case "90d":
      return new Date(now.getTime() + 90 * DAY_MS).toISOString()
    case "1y": {
      const inAYear = new Date(now.getTime())
      inAYear.setUTCFullYear(inAYear.getUTCFullYear() + 1)
      return inAYear.toISOString()
    }
    case "date": {
      if (!picked) throw new Error("A picked expiry needs a date.")
      return new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), 23, 59, 59, 999).toISOString()
    }
  }
}

export function scopeLabel(scope: ApiKeyScope): string {
  return scope === "read_write" ? "Read/write" : "Read"
}

export function apiKeysSummary(apiKeyList: ApiKeyList | undefined): string {
  if (!apiKeyList) return "Keys for scripts and monitors"
  if (!apiKeyList.available) return "Not used with APP_AUTH_DISABLED"
  const keyCount = apiKeyList.keys.length
  if (keyCount === 0) return "No keys yet"
  const readWriteCount = apiKeyList.keys.filter((apiKey) => apiKey.scope === "read_write").length
  const keys = `${keyCount} ${keyCount === 1 ? "key" : "keys"}`
  return readWriteCount > 0 ? `${keys}, ${readWriteCount} read/write` : keys
}

export function curlExample(origin: string, displayPrefix: string): string {
  return `curl -H "Authorization: Bearer ${displayPrefix}…" ${origin}/api/v1/analytics/summary`
}

/** "homepage · Read · never expires", under the reveal's title. */
export function createdKeyLine(apiKey: ApiKeyView): string {
  const expiry = expiryLabel(apiKey)
  return `${apiKey.name} · ${scopeLabel(apiKey.scope)} · ${expiry.charAt(0).toLowerCase()}${expiry.slice(1)}`
}

export function apiKeyNameError(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return "Give the key a name."
  if (trimmed.length > API_KEY_NAME_MAX_LENGTH) return `Use ${API_KEY_NAME_MAX_LENGTH} characters or fewer.`
  return null
}

/** The API error envelope's detail, else the fallback. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") return error.detail
  return fallback
}
