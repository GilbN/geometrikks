/** Presentation logic for Settings > Agents and the agent summary on
 *  Settings > Status. The API already orders instances head first, then red,
 *  amber and healthy, each by name, so nothing here re-sorts. */
import type {
  Advisory,
  HealthResponse,
  HeadIdentityView,
  InstanceView,
  InstancesResponse,
  JobReport,
} from "@/generated/api/types.gen"
import type { LedTone } from "@/components/settings/status-led"
import { formatUptime, relativeTime, type CardState } from "@/components/settings/status-logic"
import { displayVersion, publicVersion, sameRelease } from "@/lib/version"

export type AgentTone = "emerald" | "amber" | "red" | "muted"

export interface AgentSummary {
  tone: AgentTone
  line: string
}

export interface AgentAdvisoryCard {
  instanceName: string
  tone: "red" | "amber"
  summary: string
  moreCount: number
  /** "2d ago", against the head's clock rather than the browser's. */
  lastSeenAgo: string
}

interface ProblemKind {
  matches: (problemId: string) => boolean
  label: string
  pluralLabel?: string
}

const OUT_OF_DATE_IDS = new Set(["instance-schema-behind", "instance-version-mismatch"])

// Order is the summary's word order, worst first. The last kind catches
// advisories forwarded from the agent's own /health and anything newer.
const PROBLEM_KINDS: ProblemKind[] = [
  { matches: (problemId) => problemId === "instance-not-checking-in", label: "not checking in" },
  { matches: (problemId) => OUT_OF_DATE_IDS.has(problemId), label: "out of date" },
  { matches: (problemId) => problemId === "instance-schema-ahead", label: "newer than the head" },
  { matches: (problemId) => problemId === "instance-name-conflict", label: "with a name conflict" },
  { matches: (problemId) => problemId === "instance-name-not-set", label: "unnamed" },
  { matches: (problemId) => problemId === "instance-restart-loop", label: "restarting" },
  { matches: () => true, label: "needs attention", pluralLabel: "need attention" },
]

function problemKindIndex(problemId: string): number {
  return PROBLEM_KINDS.findIndex((kind) => kind.matches(problemId))
}

export function agentInstances(response: InstancesResponse | undefined): InstanceView[] {
  return (response?.instances ?? []).filter((instance) => !instance.isSelf)
}

export function agentsNeedingAttention(response: InstancesResponse | undefined): InstanceView[] {
  return agentInstances(response).filter((instance) => instance.status !== "ok")
}

const STATUS_LABELS: Record<InstanceView["status"], string> = {
  ok: "Healthy",
  warning: "Needs attention",
  critical: "Critical",
}

/** The status light's meaning in words, for screen readers. */
export function instanceStatusLabel(status: InstanceView["status"]): string {
  return STATUS_LABELS[status]
}

/** TanStack Router parses `?instance=123` into a number and `?instance=true`
 *  into a boolean, and instance names can be either. */
export function instanceSearchValue(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "string" && value !== "") return value
  return undefined
}

export function instanceTone(instance: InstanceView): LedTone {
  if (instance.status === "critical") return "red"
  if (instance.status === "warning") return "amber"
  return "emerald"
}

/** "3 agents, 1 out of date, 1 not checking in". An agent counts once per
 *  kind, so one with two forwarded advisories still adds 1. */
export function agentSummary(response: InstancesResponse | undefined): AgentSummary | null {
  const agents = agentInstances(response)
  if (agents.length === 0) return null
  const kindCounts = PROBLEM_KINDS.map(() => 0)
  for (const agent of agents) {
    const agentKinds = new Set(agent.problems.map((problem) => problemKindIndex(problem.id)))
    for (const kindIndex of agentKinds) kindCounts[kindIndex] += 1
  }
  const agentCount = agents.length === 1 ? "1 agent" : `${agents.length} agents`
  const kindParts = PROBLEM_KINDS.flatMap((kind, kindIndex) => {
    const count = kindCounts[kindIndex]
    if (count === 0) return []
    return [`${count} ${count === 1 ? kind.label : (kind.pluralLabel ?? kind.label)}`]
  })
  let tone: AgentTone = "emerald"
  if (agents.some((agent) => agent.status === "critical")) tone = "red"
  else if (agents.some((agent) => agent.status === "warning")) tone = "amber"
  if (kindParts.length === 0) {
    return { tone, line: agents.length === 1 ? `${agentCount}, healthy` : `${agentCount}, all healthy` }
  }
  return { tone, line: [agentCount, ...kindParts].join(", ") }
}

/** One card per agent needing attention. The backend sorts problems worst
 *  first, so the first one is the headline. */
export function agentAdvisoryCards(response: InstancesResponse | undefined): AgentAdvisoryCard[] {
  if (!response) return []
  const checkedAtMs = Date.parse(response.checkedAt)
  return agentsNeedingAttention(response).flatMap((agent) => {
    const worstProblem = agent.problems[0]
    if (!worstProblem) return []
    return [
      {
        instanceName: agent.instanceName,
        tone: agent.status === "critical" ? "red" : "amber",
        summary: worstProblem.summary,
        moreCount: agent.problems.length - 1,
        lastSeenAgo: relativeTime(agent.lastSeen, checkedAtMs),
      },
    ]
  })
}

/** A running agent would write its row straight back, so Remove only shows
 *  for rows that stopped checking in. */
export function canRemove(instance: InstanceView): boolean {
  return !instance.isSelf && !instance.checkingIn
}

/** A failed refetch keeps the last answer cached, but showing it would list
 *  agents as checking in while the head cannot read the table at all. */
export function instancesErrorState(
  isError: boolean,
  response: InstancesResponse | undefined,
): "error" | "loading" | "ready" {
  if (isError) return "error"
  if (!response) return "loading"
  return "ready"
}

/** Red when the instance was built for another migration, amber when only
 *  the version differs. */
export function versionTone(
  instance: InstanceView,
  head: HeadIdentityView,
): "red" | "amber" | null {
  if (instance.schemaRevision !== head.schemaRevision) return "red"
  if (!sameRelease(instance.appVersion, head.appVersion)) return "amber"
  return null
}

export function jobReportState(job: Pick<JobReport, "lastStatus">): CardState {
  if (job.lastStatus === "success") return { tone: "emerald", label: "ok" }
  if (job.lastStatus === "error") return { tone: "red", label: "failed" }
  if (job.lastStatus === "missed") return { tone: "amber", label: "missed" }
  if (!job.lastStatus) return { tone: "muted", label: "not run yet" }
  return { tone: "muted", label: job.lastStatus }
}

const SOURCE_REASON_LABELS: Record<string, string> = {
  missing: "missing",
  unreadable: "not readable",
  rejected: "rejected by Loki",
  unreachable: "unreachable",
}

export function sourceReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "unavailable"
  return SOURCE_REASON_LABELS[reason] ?? reason
}

const SCHEMA_WAIT_STATES: Record<string, CardState> = {
  ready: { tone: "emerald", label: "ready" },
  waiting: { tone: "amber", label: "waiting for the head to migrate" },
  newer: { tone: "amber", label: "database is ahead of this build" },
  timeout: { tone: "red", label: "gave up waiting" },
}

/** Null for a head, which migrates instead of waiting. */
export function schemaWaitState(schemaWait: string | null | undefined): CardState | null {
  if (!schemaWait) return null
  return SCHEMA_WAIT_STATES[schemaWait] ?? { tone: "muted", label: schemaWait }
}

/** Writes failing now outrank a missing source; failedBatches counts since
 *  startup, so only the 5-minute count says whether it is still happening. */
export function agentIngestionState(
  ingestion: HealthResponse["ingestion"] | undefined,
  failedLastFiveMinutes: number | null | undefined,
): CardState {
  if (!ingestion) return { tone: "muted", label: "unknown" }
  if (ingestion.status === "disabled") return { tone: "muted", label: "turned off" }
  if (!ingestion.running) return { tone: "amber", label: "not running" }
  if ((failedLastFiveMinutes ?? 0) > 0) return { tone: "red", label: "running, writes failing" }
  if ((ingestion.unavailableSources ?? []).length > 0) {
    return { tone: "amber", label: "running, a source is unavailable" }
  }
  return { tone: "emerald", label: "running" }
}

/** A run of text in a summary line; red or amber parts are colored. */
export interface TextPart {
  text: string
  tone?: "red" | "amber"
  /** Versions break at their hyphens otherwise. */
  nowrap?: boolean
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function withoutFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text
}

/** The version as a tag without its +local suffix, "v0.23.0-dev.5". */
export function shortVersion(version: string): string {
  return displayVersion(publicVersion(version))
}

/** A few words for a problem, for a list row that has no room for the
 *  sentence. Problems the head computes get fixed wording; forwarded ones
 *  keep their own summary. */
export function problemHeadline(problem: Pick<Advisory, "id" | "summary">, instanceName: string): string {
  switch (problem.id) {
    case "instance-not-checking-in":
      return "Not checking in"
    case "instance-schema-behind":
    case "instance-version-mismatch":
      return "Out of date"
    case "instance-schema-ahead":
      return "Newer than the head"
    case "instance-name-conflict":
      return "Name used by more than one process"
    case "instance-name-not-set":
      return "Runs under the default name"
    case "instance-payload-unreadable":
      return "Health report unreadable"
  }
  const summary = withoutFinalPeriod(problem.summary)
  if (problem.id === "instance-ingestion-degraded" && summary.startsWith(`Ingestion on ${instanceName} `)) {
    return "Ingestion not running"
  }
  const namePrefix = `${instanceName} `
  if (!summary.startsWith(namePrefix)) return summary
  const rest = summary.slice(namePrefix.length)
  if (rest.startsWith("cannot read ")) return `Can't read ${rest.slice("cannot read ".length)}`
  return capitalize(rest)
}

function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

/** The second line of an agent's list row: what is wrong, or "Healthy" and
 *  how much it read in the last 5 minutes. */
export function instanceRowLine(instance: InstanceView): TextPart[] {
  const [worstProblem, ...otherProblems] = instance.problems
  if (worstProblem) {
    const parts: TextPart[] = [{ text: problemHeadline(worstProblem, instance.instanceName) }]
    if (otherProblems.length > 0) parts.push({ text: `${countText(otherProblems.length, "more problem")}` })
    return parts
  }
  const parts: TextPart[] = [{ text: "Healthy" }]
  const payload = instance.payload
  const linesLastFiveMinutes = payload?.lines5M
  const failedLastFiveMinutes = payload?.failed5M ?? 0
  if ((payload?.sources ?? []).length === 0) {
    parts.push({ text: instance.isSelf ? "serves the UI, no log sources" : "no log sources" })
  } else if (linesLastFiveMinutes === null || linesLastFiveMinutes === undefined) {
    parts.push({ text: "line count needs 5 minutes of heartbeats" })
  } else {
    parts.push({ text: `${countText(linesLastFiveMinutes, "line")} in 5 min` })
  }
  if (failedLastFiveMinutes > 0) parts.push({ text: `${failedLastFiveMinutes.toLocaleString()} failed`, tone: "red" })
  return parts
}

/** The line under the agent's name in its details: when it was last seen,
 *  how long it has run and whether its version matches the head's. */
export function instanceHeaderLine(instance: InstanceView, head: HeadIdentityView, checkedAtMs: number): TextPart[][] {
  const seen = relativeTime(instance.lastSeen, checkedAtMs)
  const drift = versionTone(instance, head)
  const version: TextPart[] = drift
    ? [
        { text: shortVersion(instance.appVersion), tone: drift, nowrap: true },
        { text: ", head " },
        { text: shortVersion(head.appVersion), nowrap: true },
      ]
    : [{ text: shortVersion(instance.appVersion), nowrap: true }]
  if (!instance.checkingIn) {
    return [[{ text: `Last seen ${seen}`, tone: "red" }], version, [{ text: "details from its last heartbeat" }]]
  }
  const uptime = formatUptime(instance.startedAt, checkedAtMs)
  return [[{ text: `Seen ${seen}` }], ...(uptime ? [[{ text: uptime }]] : []), version]
}

/** Why the version is colored, in words. */
export function versionDriftText(tone: "red" | "amber" | null): string | null {
  if (tone === "red") return "built for a different migration than the head"
  if (tone === "amber") return "a different version than the head"
  return null
}

/** A failed write's message without the exception class prefixes, so the
 *  database's own sentence leads. */
export function errorHeadline(message: string): string {
  return message
    .replace(/^\([^)]*\)\s*/, "")
    .replace(/^<class '[^']*'>:\s*/, "")
    .trim()
}

export type DetailSectionId =
  | "ingestion"
  | "last-error"
  | "sources"
  | "jobs"
  | "geoip"
  | "instance"
  | "server-locations"

export interface DetailSection {
  id: DetailSectionId
  title: string
  tone: LedTone
  summary: TextPart[]
}

/** Lights that describe the agent right now. Once it stops checking in they
 *  only say how it was at its last heartbeat, so they go grey. */
export function liveTone(tone: LedTone, checkingIn: boolean): LedTone {
  return checkingIn ? tone : "muted"
}

function partTone(tone: LedTone): TextPart["tone"] {
  return tone === "red" || tone === "amber" ? tone : undefined
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

function ingestionSection(instance: InstanceView): DetailSection {
  const health = instance.health
  const title = "Ingestion"
  if (!health) {
    return { id: "ingestion", title, tone: "muted", summary: [{ text: "Unknown" }, { text: "no readable health report" }] }
  }
  const failedLastFiveMinutes = instance.payload?.failed5M ?? 0
  const state = agentIngestionState(health.ingestion, failedLastFiveMinutes)
  const parsedLines = { text: countText(health.ingestion.parsedLines, "line") }
  if (!instance.checkingIn) {
    return { id: "ingestion", title, tone: "muted", summary: [{ text: `${capitalize(state.label)} when last seen` }, parsedLines] }
  }
  return {
    id: "ingestion",
    title,
    tone: state.tone,
    summary: [
      { text: capitalize(state.label), tone: partTone(state.tone) },
      failedLastFiveMinutes > 0 ? { text: `${failedLastFiveMinutes.toLocaleString()} failed in 5 min` } : parsedLines,
    ],
  }
}

function lastErrorSection(instance: InstanceView): DetailSection | null {
  const message = instance.payload?.lastError?.message
  if (!message) return null
  // The last error is kept since startup; only a failure in the last 5
  // minutes means writes are still failing.
  const failingNow = (instance.payload?.failed5M ?? 0) > 0
  return { id: "last-error", title: "Last error", tone: failingNow ? "red" : "amber", summary: [{ text: errorHeadline(message) }] }
}

function sourcesSection(instance: InstanceView, ingestionShowsLines: boolean): DetailSection {
  const sources = instance.payload?.sources ?? []
  const title = "Sources"
  if (sources.length === 0) return { id: "sources", title, tone: "muted", summary: [{ text: "None reported" }] }
  const unavailableCount = sources.filter((source) => !source.available).length
  const tone = liveTone(unavailableCount > 0 ? "red" : "emerald", instance.checkingIn)
  if (sources.length === 1) {
    const [source] = sources
    const label = { text: source.label || "unnamed source" }
    if (!source.available) return { id: "sources", title, tone, summary: [label, { text: sourceReasonLabel(source.reason), tone: partTone(tone) }] }
    // The Ingestion line already counts the lines when nothing fails.
    const second = ingestionShowsLines
      ? { text: source.logFormat || "format pending" }
      : { text: countText(source.parsedLines ?? 0, "line") }
    return { id: "sources", title, tone, summary: [label, second] }
  }
  const totalLines = sources.reduce((sum, source) => sum + (source.parsedLines ?? 0), 0)
  return {
    id: "sources",
    title,
    tone,
    summary: [
      { text: countText(sources.length, "source") },
      unavailableCount > 0
        ? { text: `${unavailableCount.toLocaleString()} unavailable`, tone: partTone(tone) }
        : { text: countText(totalLines, "line") },
    ],
  }
}

function jobsSection(instance: InstanceView, nowMs: number): DetailSection {
  const jobs = instance.payload?.jobs ?? []
  const title = "Scheduled jobs"
  if (jobs.length === 0) return { id: "jobs", title, tone: "muted", summary: [{ text: "None reported" }] }
  const failedJobs = jobs.filter((job) => job.lastStatus === "error")
  const countsByLabel = new Map<string, number>()
  for (const job of jobs) {
    if (job.lastStatus === "error") continue
    const label = jobReportState(job).label
    countsByLabel.set(label, (countsByLabel.get(label) ?? 0) + 1)
  }
  const summary: TextPart[] = []
  if (failedJobs.length === 1) {
    const [failedJob] = failedJobs
    const when = failedJob.lastStart ? ` ${relativeTime(failedJob.lastStart, nowMs)}` : ""
    summary.push({ text: `${failedJob.name || failedJob.id || "A job"} failed${when}` })
  } else if (failedJobs.length > 1) {
    summary.push({ text: `${failedJobs.length.toLocaleString()} failed` })
  }
  for (const [label, count] of countsByLabel) summary.push({ text: `${count.toLocaleString()} ${label}` })
  let tone: LedTone = "muted"
  if (failedJobs.length > 0) tone = "red"
  else if (jobs.some((job) => job.lastStatus === "missed")) tone = "amber"
  else if (jobs.some((job) => job.lastStatus === "success")) tone = "emerald"
  return { id: "jobs", title, tone, summary }
}

function geoipSection(instance: InstanceView, nowMs: number): DetailSection {
  const geoip = instance.health?.geoip
  const title = "GeoIP"
  if (!geoip) return { id: "geoip", title, tone: "muted", summary: [{ text: "Unknown" }] }
  if (!geoip.available) {
    return { id: "geoip", title, tone: liveTone("red", instance.checkingIn), summary: [{ text: "City not loaded", tone: instance.checkingIn ? "red" : undefined }] }
  }
  const built = geoip.dbBuildDate ? ` built ${formatShortDate(geoip.dbBuildDate)}, ${relativeTime(geoip.dbBuildDate, nowMs)}` : " loaded"
  const summary: TextPart[] = geoip.asnAvailable
    ? [{ text: `City and ASN${built}` }]
    : [{ text: `City${built}` }, { text: "ASN not loaded" }]
  return { id: "geoip", title, tone: liveTone("emerald", instance.checkingIn), summary }
}

function instanceSection(instance: InstanceView): DetailSection {
  const health = instance.health
  const schemaWait = schemaWaitState(health?.schemaWait)
  const summary: TextPart[] = [{ text: instance.mode }, { text: `migration ${instance.schemaRevision}` }]
  let tone: LedTone = "muted"
  if (health) {
    const reachable = health.database.reachable
    summary.push({ text: reachable ? "database reachable" : "database unreachable", tone: reachable ? undefined : "red" })
    tone = reachable ? "emerald" : "red"
    if (schemaWait && tone === "emerald" && schemaWait.tone !== "emerald") tone = schemaWait.tone
    if (schemaWait?.tone === "red") tone = "red"
  }
  if (!instance.checkingIn) {
    tone = "muted"
    for (const part of summary) part.tone = undefined
  }
  return { id: "instance", title: "Instance", tone, summary }
}

function serverLocationsSection(instance: InstanceView): DetailSection {
  const serverLocations = instance.serverLocations
  const title = "Server locations"
  if (serverLocations.length === 0) {
    return { id: "server-locations", title, tone: "muted", summary: [{ text: "None recorded yet" }] }
  }
  if (serverLocations.length === 1) {
    const [serverLocation] = serverLocations
    return {
      id: "server-locations",
      title,
      tone: "emerald",
      summary: [
        { text: serverLocation.server },
        { text: `${serverLocation.latitude.toFixed(2)}, ${serverLocation.longitude.toFixed(2)}` },
      ],
    }
  }
  return {
    id: "server-locations",
    title,
    tone: "emerald",
    summary: [
      { text: countText(serverLocations.length, "server") },
      { text: serverLocations.map((serverLocation) => serverLocation.server).join(", ") },
    ],
  }
}

/** The detail sections of an agent, each with a light and a one-line
 *  summary. Red and amber sections come first so a failure is on the first
 *  screen; the rest keep their usual order. */
export function instanceDetailSections(instance: InstanceView, nowMs: number): DetailSection[] {
  const ingestion = ingestionSection(instance)
  const ingestionShowsLines = (instance.payload?.failed5M ?? 0) === 0 && instance.health !== null
  const sections = [
    ingestion,
    lastErrorSection(instance),
    sourcesSection(instance, ingestionShowsLines),
    jobsSection(instance, nowMs),
    geoipSection(instance, nowMs),
    instanceSection(instance),
    serverLocationsSection(instance),
  ].filter((section): section is DetailSection => section !== null)
  const needsAttention = (section: DetailSection) => section.tone === "red" || section.tone === "amber"
  return [...sections.filter(needsAttention), ...sections.filter((section) => !needsAttention(section))]
}

/** How far to scroll so a deep-linked row and its details show, without
 *  pushing the card's title and column headers off the top unless the row
 *  would stay out of view. Rects are relative to the viewport. */
export function deepLinkScrollDelta({
  viewportTop,
  viewportBottom,
  cardTop,
  rowTop,
  rowBottom,
  detailBottom,
}: {
  viewportTop: number
  viewportBottom: number
  cardTop: number
  rowTop: number
  rowBottom: number
  detailBottom: number
}): number {
  const margin = 16
  const needed = detailBottom + margin - viewportBottom
  if (needed <= 0) return 0
  const keepCard = Math.max(0, Math.min(needed, cardTop - viewportTop))
  if (rowBottom - keepCard <= viewportBottom) return keepCard
  return Math.max(0, Math.min(needed, rowTop - viewportTop - margin))
}
