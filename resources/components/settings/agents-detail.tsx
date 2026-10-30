/**
 * The pieces of an agent's details, shared by the expanded table row on wide
 * cards and the bottom drawer on narrow ones.
 */
import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, Copy } from "lucide-react"
import { toast } from "sonner"
import type { Advisory, HeadIdentityView, InstanceView } from "@/generated/api/types.gen"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { displayVersion } from "@/lib/version"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { type LedTone, MonoChip, StatusLed } from "@/components/settings/status-led"
import { formatUptime, relativeTime } from "@/components/settings/status-logic"
import {
  agentIngestionState,
  jobReportState,
  liveTone,
  schemaWaitState,
  sourceReasonLabel,
  type TextPart,
  versionDriftText,
  versionTone,
} from "@/components/settings/agents-logic"

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

const partToneClasses = { red: "text-red-500", amber: "text-amber-500" } as const

/** Parts joined by middots, each colored by its tone. */
export function PartsLine({ parts }: { parts: readonly TextPart[] }) {
  return (
    <>
      {parts.map((part, partIndex) => (
        <span key={partIndex}>
          {partIndex > 0 && " · "}
          <span className={part.tone ? partToneClasses[part.tone] : undefined}>{part.text}</span>
        </span>
      ))}
    </>
  )
}

function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">{children}</dl>
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2 tabular-nums">{children}</dd>
    </>
  )
}

function LedValue({ tone, children }: { tone: LedTone; children: React.ReactNode }) {
  return (
    <>
      <StatusLed tone={tone} className="mt-1" />
      <span className="min-w-0 break-words">{children}</span>
    </>
  )
}

function NoHealthReport() {
  return (
    <p className="text-xs text-muted-foreground">
      The head can't read this agent's health report. Run the same version on both.
    </p>
  )
}

/** Copies a fix. The fallback textarea goes inside the open dialog or
 *  drawer, whose focus trap would otherwise take the selection away. */
function CopyFixButton({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])
  async function copyFix(button: HTMLElement) {
    const container = button.closest<HTMLElement>("[role='dialog']")
    const copied = await copyText(text, { container })
    setCopyState(copied ? "copied" : "failed")
    if (!copied) toast.error("Clipboard access was blocked. Select the text to copy it.")
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), copied ? 1500 : 4000)
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copyState === "copied" ? "Copied" : "Copy the fix"}
      className="-my-1.5 -mr-1.5 shrink-0 text-muted-foreground"
      onClick={(event) => {
        event.stopPropagation()
        void copyFix(event.currentTarget)
      }}
    >
      {copyState === "copied" ? (
        <Check />
      ) : copyState === "failed" ? (
        <AlertTriangle className="text-amber-600 dark:text-amber-400" />
      ) : (
        <Copy />
      )}
    </Button>
  )
}

/** One problem: what is wrong, why, and the fix with a copy button.
 *  `action` replaces the fix, for a problem the page can fix itself. */
export function ProblemCard({ problem, action }: { problem: Advisory; action?: React.ReactNode }) {
  const tone = problem.severity === "critical" ? "red" : "amber"
  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-lg border-l-2 bg-muted/40 px-3 py-2.5",
        tone === "red" ? "border-l-red-500" : "border-l-amber-500",
      )}
    >
      <div className="flex items-start gap-2 text-sm font-medium leading-snug">
        <StatusLed tone={tone} className="mt-1.5" />
        <span className="min-w-0 break-words">{problem.summary}</span>
      </div>
      {problem.detail && <p className="text-xs text-muted-foreground">{problem.detail}</p>}
      {action ??
        (problem.remedy && (
          <div className="flex items-start gap-2 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs leading-relaxed">
            <span className="min-w-0 flex-1 whitespace-pre-line break-words">{problem.remedy}</span>
            <CopyFixButton text={problem.remedy} />
          </div>
        ))}
      {problem.docsUrl && (
        <a
          href={problem.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="w-fit text-xs text-primary underline underline-offset-2"
        >
          Setup guide
        </a>
      )}
    </div>
  )
}

export function InstanceFacts({
  instance,
  head,
  now,
}: {
  instance: InstanceView
  head: HeadIdentityView
  now: number
}) {
  const health = instance.health
  const schemaWait = schemaWaitState(health?.schemaWait)
  const uptime = instance.checkingIn ? formatUptime(instance.startedAt, now) : null
  const nameSource = instance.payload?.instanceNameSource
  const drift = versionTone(instance, head)
  const driftText = versionDriftText(drift)
  const serverNames = instance.payload?.serverNames ?? []
  const whenLastSeen = instance.checkingIn ? "" : " when last seen"
  return (
    <Facts>
      <Fact label="Mode">{instance.mode}</Fact>
      <Fact label="Version">
        <span className="min-w-0 break-words">
          <span className={cn(drift === "red" && "text-red-500", drift === "amber" && "text-amber-500")}>
            {displayVersion(instance.appVersion)}
          </span>
          {driftText && <span className="text-muted-foreground">, {driftText}</span>}
        </span>
      </Fact>
      <Fact label="Started">
        <span className="min-w-0 break-words">
          {formatDateTime(instance.startedAt)}
          {uptime && <span className="text-muted-foreground"> {uptime}</span>}
        </span>
      </Fact>
      <Fact label="Migration">
        <MonoChip>{instance.schemaRevision}</MonoChip>
      </Fact>
      {serverNames.length > 0 && <Fact label="Servers">{serverNames.join(", ")}</Fact>}
      {nameSource === "fallback" && <Fact label="Name">default name, APP_INSTANCE_NAME not set</Fact>}
      {schemaWait && (
        <Fact label="Schema check">
          <LedValue tone={liveTone(schemaWait.tone, instance.checkingIn)}>
            {schemaWait.label}
            {whenLastSeen}
          </LedValue>
        </Fact>
      )}
      {health && (
        <Fact label="Database">
          <LedValue tone={liveTone(health.database.reachable ? "emerald" : "red", instance.checkingIn)}>
            {health.database.reachable ? "reachable" : "unreachable"}
            {whenLastSeen}
          </LedValue>
        </Fact>
      )}
    </Facts>
  )
}

export function IngestionFacts({ instance, now }: { instance: InstanceView; now: number }) {
  const health = instance.health
  if (!health) return <NoHealthReport />
  const payload = instance.payload
  const ingestion = agentIngestionState(health.ingestion, payload?.failed5M)
  const linesLastFiveMinutes = payload?.lines5M
  const failedLastFiveMinutes = payload?.failed5M ?? 0
  return (
    <Facts>
      <Fact label="Status">
        <LedValue tone={liveTone(ingestion.tone, instance.checkingIn)}>
          {ingestion.label}
          {!instance.checkingIn && " when last seen"}
        </LedValue>
      </Fact>
      <Fact label="Lines, last 5 min">
        {linesLastFiveMinutes === null || linesLastFiveMinutes === undefined ? (
          <span className="text-muted-foreground">needs 5 minutes of heartbeats</span>
        ) : (
          <span>
            {linesLastFiveMinutes.toLocaleString()}
            {failedLastFiveMinutes > 0 && (
              <span className="text-red-500">, {failedLastFiveMinutes.toLocaleString()} failed</span>
            )}
          </span>
        )}
      </Fact>
      <Fact label="Parsed lines">{health.ingestion.parsedLines.toLocaleString()}</Fact>
      <Fact label="Pending">{health.ingestion.pendingRecords.toLocaleString()}</Fact>
      <Fact label="Failed">
        <span className={cn((health.ingestion.failedBatches ?? 0) > 0 && "text-red-500")}>
          {(health.ingestion.failedBatches ?? 0).toLocaleString()} batches,{" "}
          {(health.ingestion.failedRecords ?? 0).toLocaleString()} records
        </span>
      </Fact>
      <Fact label="Live feed drops">{(health.ingestion.publishDropped ?? 0).toLocaleString()}</Fact>
      <Fact label="Last record">{relativeTime(health.ingestion.lastRecordAt, now)}</Fact>
    </Facts>
  )
}

export function GeoipFacts({ instance, now }: { instance: InstanceView; now: number }) {
  const health = instance.health
  if (!health) return <NoHealthReport />
  return (
    <Facts>
      <Fact label="City">
        <LedValue tone={liveTone(health.geoip.available ? "emerald" : "red", instance.checkingIn)}>
          {health.geoip.available
            ? health.geoip.dbBuildDate
              ? `built ${formatDate(health.geoip.dbBuildDate)}, ${relativeTime(health.geoip.dbBuildDate, now)}`
              : "loaded"
            : "not loaded"}
        </LedValue>
      </Fact>
      <Fact label="ASN">
        <LedValue tone={liveTone(health.geoip.asnAvailable ? "emerald" : "muted", instance.checkingIn)}>
          {health.geoip.asnAvailable
            ? health.geoip.asnDbBuildDate
              ? `built ${formatDate(health.geoip.asnDbBuildDate)}, ${relativeTime(health.geoip.asnDbBuildDate, now)}`
              : "loaded"
            : "not loaded"}
        </LedValue>
      </Fact>
    </Facts>
  )
}

export function JobsList({ instance, now }: { instance: InstanceView; now: number }) {
  const jobs = instance.payload?.jobs ?? []
  if (jobs.length === 0) return <p className="text-xs text-muted-foreground">No scheduled jobs reported.</p>
  return (
    <ul className="space-y-2 text-xs">
      {jobs.map((job, jobIndex) => {
        const state = jobReportState(job)
        const lastRun = job.lastStart ? `${state.label} ${relativeTime(job.lastStart, now)}` : state.label
        const nextRun = job.nextRunTime ? `, next ${relativeTime(job.nextRunTime, now)}` : ""
        return (
          <li key={job.id || jobIndex} className="flex items-start gap-2">
            <StatusLed tone={state.tone} className="mt-1" />
            <div className="min-w-0 flex-1">
              <p className="break-words">{job.name || job.id || "unnamed job"}</p>
              <p className="text-muted-foreground tabular-nums">
                {lastRun}
                {nextRun}
              </p>
              {job.lastError && (
                <p className="mt-1 break-words font-mono text-[11px] text-red-600 dark:text-red-300">
                  {job.lastError}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function SourcesList({ instance }: { instance: InstanceView }) {
  const sources = instance.payload?.sources ?? []
  if (sources.length === 0) return <p className="text-xs text-muted-foreground">No log sources reported.</p>
  return (
    <ul className="space-y-2 text-xs">
      {sources.map((source, sourceIndex) => {
        const details = [source.logFormat || "format pending", source.serverName && `server ${source.serverName}`]
          .filter(Boolean)
          .join(" · ")
        return (
          <li key={`${source.kind}:${source.label}:${sourceIndex}`} className="flex items-start gap-2">
            <StatusLed tone={liveTone(source.available ? "emerald" : "red", instance.checkingIn)} className="mt-1" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <MonoChip className="break-all">{source.label || "unnamed source"}</MonoChip>
                {source.kind === "loki" && <Badge variant="outline">Loki</Badge>}
              </div>
              <p className="text-muted-foreground tabular-nums">
                {details} · {(source.parsedLines ?? 0).toLocaleString()} lines
                {!source.available && <span className="text-red-500"> · {sourceReasonLabel(source.reason)}</span>}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function ServerLocationsList({ instance, now }: { instance: InstanceView; now: number }) {
  if (instance.serverLocations.length === 0) {
    return <p className="text-xs text-muted-foreground">No location recorded for its servers yet.</p>
  }
  return (
    <ul className="space-y-1">
      {instance.serverLocations.map((serverLocation) => (
        <li key={serverLocation.server} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <MonoChip>{serverLocation.server}</MonoChip>
          <span className="text-muted-foreground tabular-nums">
            {serverLocation.latitude.toFixed(2)}, {serverLocation.longitude.toFixed(2)}
          </span>
          <span className="ml-auto text-muted-foreground">
            {serverLocation.source}
            {serverLocation.detectedAt && `, detected ${relativeTime(serverLocation.detectedAt, now)}`}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function LastErrorBlock({ instance }: { instance: InstanceView }) {
  const lastError = instance.payload?.lastError
  if (!lastError?.message) return <p className="text-xs text-muted-foreground">No failed writes since it started.</p>
  return (
    <div className="space-y-1">
      <pre className="whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1.5 font-mono text-[11px] text-red-600 dark:text-red-300">
        {lastError.message}
      </pre>
      {lastError.at && <p className="text-xs text-muted-foreground">{formatDateTime(lastError.at)}</p>}
    </div>
  )
}
