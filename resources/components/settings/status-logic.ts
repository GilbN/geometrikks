/** Pure presentation logic for the Settings > Status page. Kept free of React
 *  so state derivation is unit-testable without rendering. */
import type { HealthResponse, MeResponse } from "@/lib/api"
import type {
  CrowdSecStatusResponse,
  HypertableStatsView,
  LogFileView,
  SchedulerJobView,
} from "@/generated/api/types.gen"
import type { LogRecord } from "@/lib/logstream"
import type { LiveFeedStatus } from "@/lib/websocket"
import type { LedTone } from "@/components/settings/status-led"

export interface CardState {
  tone: LedTone
  label: string
  detail?: string
}

export interface AdvisoryCard {
  id: string
  tone: LedTone
  label: string
  detail?: string
  remedy?: string
}

export function overallState(health: HealthResponse | undefined, isError: boolean): CardState {
  if (isError) {
    return { tone: "red", label: "Unreachable", detail: "The API did not answer the health probe." }
  }
  if (!health) return { tone: "muted", label: "Loading" }
  return health.status === "healthy"
    ? { tone: "emerald", label: "Healthy", detail: "All components operational." }
    : { tone: "amber", label: "Degraded", detail: "One or more components are not operational." }
}

/** Generic operator advisories from health; one status-page card each. */
export function advisoryCards(health: HealthResponse | undefined): AdvisoryCard[] {
  return (health?.advisories ?? []).map((a) => ({
    id: a.id,
    tone: a.severity === "critical" ? "red" : "amber",
    label: a.summary,
    detail: a.detail ?? undefined,
    remedy: a.remedy ?? undefined,
  }))
}

export function ingestionState(health: HealthResponse | undefined, isError: boolean): CardState {
  if (isError || !health) return { tone: "muted", label: "Unknown" }
  // Muted, not amber: a deliberate operator setting (UI-head deployments),
  // not a fault. Same treatment as authState's disabled branch.
  if (health.ingestion.status === "disabled") {
    return {
      tone: "muted",
      label: "Disabled",
      detail:
        "Log tailing is turned off (LOGPARSER_ENABLED=false). This instance serves data ingested by other instances or agents.",
    }
  }
  if (!health.ingestion.running) {
    return {
      tone: "amber",
      label: "Not running",
      detail: "No log files are being tailed. Check the Logs tab for ingestion errors.",
    }
  }
  if ((health.ingestion.missingFiles ?? []).length > 0) {
    return {
      tone: "amber",
      label: "Running, log file missing",
      detail: "A tailed log file has disappeared. Ingestion is waiting for it to reappear.",
    }
  }
  return { tone: "emerald", label: "Running" }
}

export type SidebarIngestionVariant = "offline" | "degraded" | "disabled" | "running" | "inactive"

/** Semantics of the sidebar's ingestion-health dot; the component maps the
 *  variant to colors/labels. Degraded wins over running: the backend can
 *  report running=true while a tailed log file is missing. */
export function sidebarIngestionVariant(
  health: HealthResponse | undefined,
  isError: boolean,
): SidebarIngestionVariant {
  if (isError) return "offline"
  if (!health) return "inactive"
  if (health.status === "degraded") return "degraded"
  if (health.ingestion.status === "disabled") return "disabled"
  if (health.ingestion.running) return "running"
  return "inactive"
}

export function databaseState(health: HealthResponse | undefined): CardState {
  if (!health) return { tone: "muted", label: "Unknown" }
  return health.database.reachable
    ? { tone: "emerald", label: "Reachable" }
    : { tone: "red", label: "Unreachable", detail: "Running in degraded mode without a database." }
}

export function geoipState(health: HealthResponse | undefined): CardState {
  if (!health) return { tone: "muted", label: "Unknown" }
  return health.geoip.available
    ? { tone: "emerald", label: "Available" }
    : {
        tone: "amber",
        label: "Missing",
        detail: "GeoLite2 database not loaded; requests cannot be geolocated.",
      }
}

export function crowdsecState(
  status: CrowdSecStatusResponse | undefined,
  isError: boolean,
): CardState {
  if (isError) return { tone: "muted", label: "Unavailable" }
  if (!status) return { tone: "muted", label: "Unknown" }
  if (!status.enabled) return { tone: "muted", label: "Disabled" }
  return status.lapiReachable
    ? { tone: "emerald", label: "LAPI reachable" }
    : {
        tone: "red",
        label: "LAPI unreachable",
        detail: "Viewing and managing bans is unavailable until the LAPI answers.",
      }
}

export function accessLogFiles(files: LogFileView[] | undefined): LogFileView[] {
  return (files ?? []).filter((f) => f.kind === "access")
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** "2.2M" / "15.4k" style approximate row counts; "-" when unknown. */
export function formatApproxRows(rows: number | null | undefined): string {
  if (rows === null || rows === undefined) return "-"
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(1)}M`
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}k`
  return `${rows}`
}

/** Aggregate compression ratio across hypertables that have compressed
 *  chunks; null when the compression policies have not run yet. */
export function compressionSummary(
  hypertables: HypertableStatsView[] | undefined,
): string | null {
  let before = 0
  let after = 0
  for (const t of hypertables ?? []) {
    if (t.beforeCompressionBytes !== null && t.afterCompressionBytes !== null) {
      before += t.beforeCompressionBytes
      after += t.afterCompressionBytes
    }
  }
  if (before === 0 || after === 0) return null
  const ratio = (before / after).toFixed(1)
  return `${ratio}x (${formatSize(before)} compressed to ${formatSize(after)})`
}

const TIME_UNITS: Array<[label: string, ms: number]> = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
]

/** "3m ago" / "in 2d" / "never". nowMs injected for testability. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "never"
  const diffMs = Date.parse(iso) - nowMs
  const abs = Math.abs(diffMs)
  for (const [label, ms] of TIME_UNITS) {
    if (abs >= ms || label === "s") {
      const value = Math.floor(abs / ms)
      return diffMs < 0 ? `${value}${label} ago` : `in ${value}${label}`
    }
  }
  return "now"
}

/** "up 2h 12m" / "up 2d 0h" / "up <1m"; null when start time is unknown. */
export function formatUptime(startedAt: string | null | undefined, nowMs: number): string | null {
  if (!startedAt) return null
  const upMs = Math.max(0, nowMs - Date.parse(startedAt))
  const days = Math.floor(upMs / 86_400_000)
  const hours = Math.floor((upMs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((upMs % 3_600_000) / 60_000)
  if (days > 0) return `up ${days}d ${hours}h`
  if (hours > 0) return `up ${hours}h ${minutes}m`
  if (minutes > 0) return `up ${minutes}m`
  return "up <1m"
}

const STALE_EVENT_MS = 15 * 60_000

/** Freshness of the most recently ingested record. */
export function lastEventState(
  lastRecordAt: string | null | undefined,
  running: boolean,
  nowMs: number,
): CardState {
  const label = relativeTime(lastRecordAt, nowMs)
  if (!lastRecordAt || !running) return { tone: "muted", label }
  if (nowMs - Date.parse(lastRecordAt) > STALE_EVENT_MS) {
    return {
      tone: "amber",
      label,
      detail: "Ingestion is running but no events have arrived recently.",
    }
  }
  return { tone: "emerald", label }
}

export function schedulerJobState(job: SchedulerJobView): CardState {
  if (job.running) return { tone: "cyan", label: "Running" }
  if (job.lastStatus === "error") {
    return { tone: "red", label: "Last run failed", detail: job.lastError ?? undefined }
  }
  if (job.lastStatus === "missed") return { tone: "amber", label: "Missed last run" }
  if (job.lastStatus === "success") return { tone: "emerald", label: "OK" }
  return { tone: "muted", label: "Not run yet" }
}

/** Newest-first error/critical records, capped at limit. Tail order is
 *  oldest to newest, so reverse before capping. */
export function filterErrorRecords(
  records: LogRecord[] | undefined,
  limit: number,
): LogRecord[] {
  return (records ?? [])
    .filter((r) => r.level === "error" || r.level === "critical")
    .reverse()
    .slice(0, limit)
}

/** The Status page actively subscribes to /ws/live while mounted, so
 *  "disconnected" here means the probe cannot connect, not idle. */
export function liveFeedState(status: LiveFeedStatus): CardState {
  if (status === "connected") return { tone: "emerald", label: "Connected" }
  if (status === "connecting") return { tone: "amber", label: "Connecting" }
  return {
    tone: "amber",
    label: "Not connected",
    detail:
      "The live WebSocket is not connecting. If this persists, check WebSocket support on your reverse proxy.",
  }
}

export function authState(me: MeResponse | undefined, isError: boolean): CardState {
  if (isError) return { tone: "muted", label: "Unavailable" }
  if (!me) return { tone: "muted", label: "Unknown" }
  // Neutral: the built-in auth being on is the expected baseline.
  if (me.mode === "session") return { tone: "muted", label: "Session login active" }
  // Amber, not muted: this is a deliberate setting, but an operator scanning
  // the status page should notice that the app is unauthenticated. Says only
  // what is observable; the app cannot tell whether a proxy is in front.
  return {
    tone: "amber",
    label: "Disabled",
    detail:
      "Built-in authentication is turned off (APP_AUTH_DISABLED=true). Anyone who can reach this app has full access.",
  }
}
