/** Pure presentation logic for the Settings > Status page. Kept free of React
 *  so state derivation is unit-testable without rendering. */
import type { HealthIngestionStatus, HealthResponse, MeResponse, OidcStatus } from "@/lib/api"
import type {
  CrowdSecStatusResponse,
  HypertableStatsView,
  LogFileView,
  SchedulerJobView,
  ServerLocationsResponse,
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
  docsUrl?: string
}

export function overallState(
  health: HealthResponse | undefined,
  isError: boolean,
  agentAttentionCount = 0,
): CardState {
  if (isError) {
    return { tone: "red", label: "Unreachable", detail: "The API did not answer the health probe." }
  }
  if (!health) return { tone: "muted", label: "Loading" }
  if (health.status !== "healthy") {
    return { tone: "amber", label: "Degraded", detail: "One or more components are not operational." }
  }
  const advisoryCount = (health.advisories ?? []).length
  if (advisoryCount > 0 || agentAttentionCount > 0) {
    const counts: string[] = []
    if (advisoryCount > 0) counts.push(countedAttention(advisoryCount, "advisory", "advisories"))
    if (agentAttentionCount > 0) counts.push(countedAttention(agentAttentionCount, "agent", "agents"))
    return { tone: "amber", label: "Attention", detail: counts.join(" ") }
  }
  return { tone: "emerald", label: "Healthy", detail: "All components operational." }
}

/** Generic operator advisories from health; one status-page card each. */
export function advisoryCards(health: HealthResponse | undefined): AdvisoryCard[] {
  return (health?.advisories ?? []).map((a) => ({
    id: a.id,
    tone: a.severity === "critical" ? "red" : "amber",
    label: a.summary,
    detail: a.detail ?? undefined,
    remedy: a.remedy ?? undefined,
    docsUrl: a.docsUrl ?? undefined,
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
  const unavailable = unavailableSources(health)
  if (unavailable.length > 0) {
    const onlyFilesWithReason = (reason: string) =>
      unavailable.every((source) => source.kind === "file" && source.reason === reason)
    if (onlyFilesWithReason("missing")) {
      return {
        tone: "amber",
        label: "Running, log file missing",
        detail: "A configured log file is missing. Ingestion is waiting for it to appear.",
      }
    }
    if (onlyFilesWithReason("unreadable")) {
      return {
        tone: "amber",
        label: "Running, log file not readable",
        detail:
          "GeoMetrikks cannot read a configured log file. Check its permissions and those of its directory. Ingestion resumes once it can.",
      }
    }
    if (unavailable.some((source) => source.kind === "loki" && source.reason === "rejected")) {
      return {
        tone: "amber",
        label: "Running, Loki rejected the query",
        detail: "Check LOKI_QUERIES and the credentials. Ingestion retries every poll.",
      }
    }
    return {
      tone: "amber",
      label: "Running, log source unavailable",
      detail: "A configured log source is unavailable. Ingestion is waiting for it to come back.",
    }
  }
  return { tone: "emerald", label: "Running" }
}

type UnavailableSource = NonNullable<HealthIngestionStatus["unavailableSources"]>[number]

function unavailableSources(health: HealthResponse | undefined): UnavailableSource[] {
  if (!health) return []
  return (
    health.ingestion.unavailableSources ??
    (health.ingestion.missingFiles ?? []).map((label) => ({
      kind: "file",
      label,
      reason: "missing",
    }))
  )
}

export type SidebarIngestionVariant =
  | "offline"
  | "degraded"
  | "attention"
  | "disabled"
  | "running"
  | "inactive"

/** Semantics of the sidebar's ingestion-health dot; the component maps the
 * variant to colors/labels. Degraded wins over advisories, which win over the
 * configured-off state. An agent needing attention counts as an advisory, but
 * the head's own offline and degraded states still come first. */
export function sidebarIngestionVariant(
  health: HealthResponse | undefined,
  isError: boolean,
  agentAttentionCount = 0,
): SidebarIngestionVariant {
  if (isError) return "offline"
  if (!health) return "inactive"
  if (health.status === "degraded") return "degraded"
  if ((health.advisories ?? []).length > 0 || agentAttentionCount > 0) return "attention"
  if (health.ingestion.status === "disabled") return "disabled"
  if (health.ingestion.running) return "running"
  return "inactive"
}

function countedAttention(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? `${singular} needs` : `${plural} need`} attention.`
}

export function sidebarStatusTooltip(
  base: string,
  advisoryCount: number,
  variant: "degraded" | "attention",
  agentAttentionCount = 0,
): string {
  const counts: string[] = []
  if (advisoryCount > 0) counts.push(countedAttention(advisoryCount, "advisory", "advisories"))
  if (agentAttentionCount > 0) counts.push(countedAttention(agentAttentionCount, "agent", "agents"))
  if (counts.length === 0) return base
  const countText = counts.join(" ")
  if (variant === "attention") {
    const page = advisoryCount === 0 ? "Settings > Agents" : "Settings > Status"
    return `${countText} See ${page}.`
  }
  const separator = /[.!?]$/.test(base) ? " " : ". "
  const statusLink = base.includes("Settings > Status") ? "" : " See Settings > Status."
  return `${base}${separator}${countText}${statusLink}`
}

/** The tail of an agent's Status card, after its worst problem. */
export function agentMoreProblemsText(moreCount: number): string | null {
  if (moreCount <= 0) return null
  return `And ${moreCount} more ${moreCount === 1 ? "problem" : "problems"}.`
}

/** The bottom Status grid holds Recent errors after the optional Agents and
 *  Server locations cards. Spanning both columns only when those pair up
 *  keeps a hole out of either row. */
export function recentErrorsFillsRow(cardsBefore: number): boolean {
  return cardsBefore % 2 === 0
}

export function databaseState(health: HealthResponse | undefined): CardState {
  if (!health) return { tone: "muted", label: "Unknown" }
  if (!health.database.reachable) {
    return { tone: "red", label: "Unreachable", detail: "Running in degraded mode without a database." }
  }
  if (health.database.servicesActive === false) {
    return {
      tone: "amber",
      label: "Reachable, services paused",
      detail: "Background jobs and ingestion are waiting for recovery. See the advisory above.",
    }
  }
  return { tone: "emerald", label: "Connected" }
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

/** Why an unavailable access log cannot be tailed, from the health entry of
 *  the file source with the same file name. The file list carries only the
 *  name; when two configured paths share one, it calls the second
 *  "access.log.2", which matches nothing and reads "unavailable". */
export function accessLogUnavailableLabel(
  file: LogFileView,
  health: HealthResponse | undefined,
): string {
  const source = unavailableSources(health).find(
    (candidate) => candidate.kind === "file" && candidate.label.split(/[\\/]/).pop() === file.name,
  )
  if (source?.reason === "missing") return "missing"
  if (source?.reason === "unreadable") return "not readable"
  return "unavailable"
}

export interface ServerLocationRow {
  server: string
  coords: string
  source: "auto" | "override"
  /** "Traffic 23 Aug" / "Traffic 2 months ago" / "No traffic". Day precision
   *  is all the backend has (it reads the daily server aggregate). */
  lastSeen: string
  /** A stale auto row; "No traffic" or 14+ days since the last day with events. */
  stale: boolean
}

const STALE_AFTER_DAYS = 14

/** Per-server rows for the Settings > Status server locations block: the
 *  server, lat/lon to 2 decimals, auto/override so an operator can tell a
 *  detected location from a configured one (e.g. diagnosing CGNAT drift),
 *  and when the server last recorded traffic so a retired one stands out.
 *  nowMs injected for testability. */
export function serverLocationRows(
  data: ServerLocationsResponse | undefined,
  nowMs: number = Date.now(),
): ServerLocationRow[] {
  return (data?.locations ?? []).map((serverLocation) => {
    const lastMs = serverLocation.lastEventDay ? Date.parse(`${serverLocation.lastEventDay}T00:00:00Z`) : null
    const ageDays = lastMs === null ? Infinity : Math.floor((nowMs - lastMs) / 86_400_000)
    return {
      server: serverLocation.server,
      coords: `${serverLocation.latitude.toFixed(2)}, ${serverLocation.longitude.toFixed(2)}`,
      source: serverLocation.source,
      lastSeen: lastMs === null ? "No traffic" : `Traffic ${formatLastDay(lastMs, ageDays)}`,
      stale: serverLocation.source === "auto" && ageDays >= STALE_AFTER_DAYS,
    }
  })
}

function formatLastDay(lastMs: number, ageDays: number): string {
  if (ageDays <= 0) return "today"
  if (ageDays === 1) return "yesterday"
  if (ageDays < 30) return `${ageDays}d ago`
  return new Date(lastMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
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
  if (job.running) return { tone: "accent", label: "Running" }
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
  if (status === "unavailable") {
    return {
      tone: "amber",
      label: "Paused by server",
      detail:
        "The server accepted the connection and closed it because the database or ingestion is not available. It reconnects on its own.",
    }
  }
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
  // Emerald, not muted: on this page the hollow dot marks things that are
  // off (Ingestion "Disabled"), and a logged-in session is not off.
  if (me.mode === "session") {
    return {
      tone: "emerald",
      label: me.provider === "oidc" ? "SSO login active" : "Session login active",
    }
  }
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

/** Null when there is nothing to show: OIDC off, still loading, or the
 *  status query itself failed (the Authentication line already says so). */
export function oidcState(status: OidcStatus | undefined, isError: boolean): CardState | null {
  if (isError || !status || !status.configured) return null
  if (status.discovery === "ok") return { tone: "emerald", label: "IdP reachable" }
  if (status.discovery === "failed") {
    return {
      tone: "red",
      label: "Discovery failed",
      detail:
        status.detail ??
        "The identity provider could not be reached. Sign-in will fail until it answers.",
    }
  }
  return { tone: "muted", label: "Checking identity provider" }
}

/** Chips under the provider line: whether the password form is still offered
 *  beside SSO, and whether logout also ends the provider session. */
export function loginMethodBadges(status: OidcStatus | undefined): string[] {
  if (!status?.configured) return []
  return [
    status.passwordLogin ? "password login on" : "password login off",
    status.idpLogout ? "IdP logout on" : "IdP logout off",
  ]
}

/** One row in the phone Status page's problem list: an operator advisory or
 *  an agent that needs attention. */
export interface StatusProblem {
  id: string
  tone: "red" | "amber"
  label: string
  detail?: string
  remedy?: string
  docsUrl?: string
  /** Set for agent problems: the agent to open on the Agents page. */
  agentName?: string
}

/** Advisories and agent problems in one list, critical ones first. */
export function statusProblems(
  advisories: readonly AdvisoryCard[],
  agents: readonly {
    instanceName: string
    tone: "red" | "amber"
    summary: string
    moreCount: number
    lastSeenAgo: string
  }[],
): StatusProblem[] {
  const rows: StatusProblem[] = [
    ...advisories.map((card) => ({
      id: card.id,
      tone: card.tone === "red" ? ("red" as const) : ("amber" as const),
      label: card.label,
      detail: card.detail,
      remedy: card.remedy,
      docsUrl: card.docsUrl,
    })),
    ...agents.map((card) => ({
      id: `agent-${card.instanceName}`,
      tone: card.tone,
      label: card.summary,
      detail: agentProblemDetail(card.lastSeenAgo, card.moreCount),
      agentName: card.instanceName,
    })),
  ]
  return rows.sort((a, b) => Number(b.tone === "red") - Number(a.tone === "red"))
}

function agentProblemDetail(lastSeenAgo: string, moreCount: number): string {
  const lastSeen = `Last seen ${lastSeenAgo}`
  if (moreCount <= 0) return lastSeen
  return `${lastSeen}, and ${moreCount} more ${moreCount === 1 ? "problem" : "problems"}`
}

/** The phone verdict: how many things need attention, or the overall state. */
export function verdictTitle(overall: CardState, problemCount: number): string {
  if (overall.label === "Attention" && problemCount > 0) {
    return problemCount === 1 ? "1 thing needs attention" : `${problemCount} things need attention`
  }
  return overall.label
}

const TONE_RANK: Record<LedTone, number> = { red: 4, amber: 3, accent: 2, emerald: 1, muted: 0 }

/** The Scheduler tile: the worst job state as its light, and the next run. */
export function schedulerSummary(
  jobs: readonly SchedulerJobView[] | undefined,
  isError: boolean,
  now: number,
): CardState {
  if (isError) return { tone: "muted", label: "Unavailable" }
  if (!jobs) return { tone: "muted", label: "Loading" }
  const tone = jobs
    .map((job) => schedulerJobState(job).tone)
    .reduce<LedTone>((worst, next) => (TONE_RANK[next] > TONE_RANK[worst] ? next : worst), "muted")
  const nextRun = jobs
    .map((job) => job.nextRunTime)
    .filter((time): time is string => !!time)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
  // The light alone doesn't reach a screen reader, so problems go in the text.
  const failed = jobs.filter((job) => !job.running && job.lastStatus === "error").length
  const missed = jobs.filter((job) => !job.running && job.lastStatus === "missed").length
  const parts = [
    jobs.length === 1 ? "1 job" : `${jobs.length} jobs`,
    failed > 0 ? `${failed} failed` : null,
    missed > 0 ? `${missed} missed` : null,
  ]
  return {
    tone,
    label: parts.filter(Boolean).join(", "),
    detail: nextRun ? `Next ${relativeTime(nextRun, now)}` : undefined,
  }
}
