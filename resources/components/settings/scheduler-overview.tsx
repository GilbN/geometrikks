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
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import type { SchedulerJobView } from "@/generated/api/types.gen"

// Pinned to "en": the rest of the UI is English, so browser-locale words
// ("om 2 timer") would read as a glitch here.
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

function relativeTime(iso: string | null | undefined): string {
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
      return rtf.format(Math.round(diffMs / ms), unit)
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
      <span className="inline-flex items-center gap-1.5 text-sm text-geo-cyan tabular-nums">
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
      <span className="inline-flex items-center gap-2 text-sm text-geo-cyan">
        <StatusLed tone="cyan" pulse />
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

  if (!data.schedulerEnabled) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
              <Clock className="h-4 w-4 text-geo-cyan" />
            </div>
            <div>
              <CardTitle className="text-base">
                <span className="inline-flex items-center gap-2">
                  <StatusLed tone="red" />
                  Scheduler disabled
                </span>
              </CardTitle>
              <CardDescription>
                Background tasks are turned off (SCHEDULER_ENABLED=false) or the scheduler did
                not start. Enable it and restart to see jobs here.
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
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
            <Clock className="h-4 w-4 text-geo-cyan" />
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
      <CardContent>
        <Table>
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
