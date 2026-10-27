import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, Clock, Play, Timer } from "lucide-react"
import { runSchedulerJob } from "@/lib/api"
import { useSchedulerJobs, queryKeys } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { describeTrigger } from "@/components/settings/scheduler-logic"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import type { SchedulerJobView } from "@/generated/api/types.gen"

// Pinned to "en": the rest of the UI is English, so browser-locale words
// ("om 2 timer") would read as a glitch here.
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
// "in 50s" rather than "in 50 seconds", so three timings fit a phone row.
const narrowRtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" })

function relativeTime(iso: string | null | undefined, format = rtf): string {
  if (!iso) return "never"
  const diffMs = new Date(iso).getTime() - Date.now()
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ]
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms || unit === "second") {
      return format.format(Math.round(diffMs / ms), unit)
    }
  }
  return "now"
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return ""
  if (seconds < 1) return "<1s"
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

/** Re-renders every second while anything is running so elapsed time ticks. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

function DurationCell({ job }: { job: SchedulerJobView }) {
  if (job.running && job.lastRunTime) {
    const elapsed = (Date.now() - new Date(job.lastRunTime).getTime()) / 1000
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-primary tabular-nums">
        <Timer className="h-3.5 w-3.5" />
        {formatDuration(Math.max(0, elapsed))}
      </span>
    )
  }
  if (job.lastDurationSeconds === null || job.lastDurationSeconds === undefined) {
    return <span className="text-sm text-muted-foreground">-</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm tabular-nums">
      <Timer className="h-3.5 w-3.5 text-muted-foreground" />
      {formatDuration(job.lastDurationSeconds)}
    </span>
  )
}

function StatusCell({ job }: { job: SchedulerJobView }) {
  if (job.running) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-primary">
        <StatusLed tone="accent" pulse />
        running
      </span>
    )
  }
  if (!job.nextRunTime) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
        <StatusLed tone="amber" />
        paused
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <StatusLed tone="muted" />
      idle
    </span>
  )
}

const statusBadgeClasses: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  missed: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

function LastRunCell({ job }: { job: SchedulerJobView }) {
  if (!job.lastRunTime) {
    return <span className="text-sm text-muted-foreground">not since startup</span>
  }
  const badge = job.lastStatus ? (
    <Badge variant="outline" className={cn("gap-1", statusBadgeClasses[job.lastStatus])}>
      {job.lastStatus}
    </Badge>
  ) : null
  return (
    <div className="space-y-1">
      <div className="text-sm">{relativeTime(job.lastRunTime)}</div>
      {job.lastStatus === "error" ? (
        <Tooltip>
          <TooltipTrigger asChild>{badge ?? <span />}</TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">
            {job.lastError ?? "unknown error"}
          </TooltipContent>
        </Tooltip>
      ) : (
        badge
      )}
    </div>
  )
}

function jobState(job: SchedulerJobView): { tone: LedTone; label: string } {
  if (job.running) return { tone: "accent", label: "running" }
  if (!job.nextRunTime) return { tone: "amber", label: "paused" }
  return { tone: "muted", label: "idle" }
}

function JobFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm tabular-nums">{children}</dd>
    </div>
  )
}

/** Narrow-card layout for one job. Touch screens can't open tooltips, so a
 * failed run's error goes under the timings, clamped until tapped. */
function JobItem({
  job,
  runDisabled,
  onRun,
}: {
  job: SchedulerJobView
  runDisabled: boolean
  onRun: () => void
}) {
  const state = jobState(job)
  const [errorExpanded, setErrorExpanded] = useState(false)
  const elapsed =
    job.running && job.lastRunTime
      ? Math.max(0, (Date.now() - new Date(job.lastRunTime).getTime()) / 1000)
      : null
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <StatusLed tone={state.tone} pulse={job.running} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">
            {job.name}
            <span className="sr-only">, {state.label}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span title={job.trigger}>{describeTrigger(job.trigger)}</span>
            {job.lastStatus && job.lastStatus !== "success" && (
              <Badge variant="outline" className={statusBadgeClasses[job.lastStatus]}>
                {job.lastStatus === "error" ? "last run failed" : "last run missed"}
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="icon-lg"
          variant="outline"
          className="-mt-0.5 shrink-0"
          aria-label={`Run ${job.name} now`}
          disabled={runDisabled}
          onClick={onRun}
        >
          <Play className="h-4 w-4" />
        </Button>
      </div>
      <dl className="mt-2 grid max-w-md grid-cols-3 gap-3 pl-5">
        <JobFact label="Last run">
          {job.lastRunTime ? (
            relativeTime(job.lastRunTime, narrowRtf)
          ) : (
            <span className="text-muted-foreground">not yet</span>
          )}
        </JobFact>
        <JobFact label={elapsed === null ? "Took" : "Running for"}>
          {elapsed !== null ? (
            <span className="text-primary">{formatDuration(elapsed)}</span>
          ) : job.lastDurationSeconds === null ? (
            <span className="text-muted-foreground">-</span>
          ) : (
            formatDuration(job.lastDurationSeconds)
          )}
        </JobFact>
        <JobFact label="Next run">
          {job.nextRunTime ? (
            relativeTime(job.nextRunTime, narrowRtf)
          ) : (
            <span className="text-amber-600 dark:text-amber-400">paused</span>
          )}
        </JobFact>
      </dl>
      {job.lastStatus === "error" && (
        <button
          type="button"
          aria-expanded={errorExpanded}
          onClick={() => setErrorExpanded((expanded) => !expanded)}
          className={cn(
            "mt-2 ml-5 block w-[calc(100%-1.25rem)] break-all rounded-sm border-l-2 border-red-500/50 pl-2 text-left font-mono text-[11px] text-red-600 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-red-400",
            !errorExpanded && "line-clamp-3",
          )}
        >
          {job.lastError ?? "unknown error"}
        </button>
      )}
    </li>
  )
}

export function SchedulerOverview() {
  const { data, isLoading } = useSchedulerJobs()
  const queryClient = useQueryClient()
  const runJob = useMutation({
    mutationFn: runSchedulerJob,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.system.schedulerJobs }),
  })
  useTicker(data?.jobs.some((j) => j.running) ?? false)

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  if (data.status !== "running") {
    const unavailable = data.status === "unavailable"
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Clock className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">
                <span className="inline-flex items-center gap-2">
                  <StatusLed tone={unavailable ? "amber" : "red"} />
                  {unavailable ? "Background jobs not started" : "Scheduler disabled"}
                </span>
              </CardTitle>
              <CardDescription>
                {unavailable
                  ? "The database was unreachable when the app started. Jobs start on their own once it answers; see Settings > Status."
                  : "Background tasks are turned off (SCHEDULER_ENABLED=false)."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    )
  }

  const runningCount = data.jobs.filter((j) => j.running).length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Clock className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-2">
                <StatusLed
                  tone={data.schedulerRunning ? "emerald" : "red"}
                  pulse={runningCount > 0}
                />
                Scheduled tasks
              </span>
            </CardTitle>
            <CardDescription>
              {data.jobs.length} background jobs, scheduler{" "}
              {data.schedulerRunning ? "running" : "stopped"}. Last-run info resets on app
              restart.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      {/* Switches on the card's width, not the viewport's. From md up, the
          sidebar and settings nav leave the card narrower than the table's 800px. */}
      <CardContent className="@container">
        <ul className="divide-y @[50rem]:hidden">
          {data.jobs.map((job) => (
            <JobItem
              key={job.id}
              job={job}
              runDisabled={job.running || runJob.isPending}
              onRun={() => runJob.mutate(job.id)}
            />
          ))}
        </ul>
        <Table containerClassName="@max-[50rem]:hidden">
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="align-top">
                  <div className="font-medium">{job.name}</div>
                  <MonoChip className="mt-0.5 inline-block max-w-xs truncate">
                    {job.trigger}
                  </MonoChip>
                </TableCell>
                <TableCell className="align-top">
                  <StatusCell job={job} />
                </TableCell>
                <TableCell className="align-top">
                  <LastRunCell job={job} />
                </TableCell>
                <TableCell className="align-top">
                  <DurationCell job={job} />
                </TableCell>
                <TableCell className="align-top text-sm">
                  {job.nextRunTime ? (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                      {relativeTime(job.nextRunTime)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">paused</span>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <Button
                    size="sm"
                    className="pointer-coarse:h-10"
                    variant="outline"
                    disabled={job.running || runJob.isPending}
                    onClick={() => runJob.mutate(job.id)}
                  >
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    Run now
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
