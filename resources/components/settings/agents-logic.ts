/** Presentation logic for Settings > Agents and the agent summary on
 *  Settings > Status. The API already orders instances head first, then red,
 *  amber and healthy, each by name, so nothing here re-sorts. */
import type {
  HealthResponse,
  HeadIdentityView,
  InstanceView,
  InstancesResponse,
  JobReport,
} from "@/generated/api/types.gen"
import type { LedTone } from "@/components/settings/status-led"
import type { CardState } from "@/components/settings/status-logic"

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
  return agentsNeedingAttention(response).flatMap((agent) => {
    const worstProblem = agent.problems[0]
    if (!worstProblem) return []
    return [
      {
        instanceName: agent.instanceName,
        tone: agent.status === "critical" ? "red" : "amber",
        summary: worstProblem.summary,
        moreCount: agent.problems.length - 1,
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
  if (instance.appVersion !== head.appVersion) return "amber"
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

/** Same rule as the backend's problem text: a source checkout reports "unknown". */
export function versionText(version: string): string {
  if (!version) return "unknown"
  return /^\d/.test(version) ? `v${version}` : version
}
