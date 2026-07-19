import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Play } from "lucide-react"
import { runSchedulerJob } from "@/lib/api"
import { useSchedulerJobs, queryKeys } from "@/lib/queries"
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
import type { SchedulerJobView } from "@/generated/api/types.gen"

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never"
  const diffMs = new Date(iso).getTime() - Date.now()
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
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

function StatusCell({ job }: { job: SchedulerJobView }) {
  if (job.running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        running
      </span>
    )
  }
  if (!job.next_run_time) return <Badge variant="outline">paused</Badge>
  return <Badge variant="secondary">idle</Badge>
}

function LastRunCell({ job }: { job: SchedulerJobView }) {
  if (!job.last_run_time) {
    return <span className="text-sm text-muted-foreground">not since startup</span>
  }
  const duration = formatDuration(job.last_duration_seconds)
  return (
    <div className="space-y-0.5">
      <div className="text-sm">
        {relativeTime(job.last_run_time)}
        {duration && <span className="text-muted-foreground"> ({duration})</span>}
      </div>
      {job.last_status === "error" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive">error</Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">
            {job.last_error ?? "unknown error"}
          </TooltipContent>
        </Tooltip>
      ) : job.last_status ? (
        <Badge variant="outline">{job.last_status}</Badge>
      ) : null}
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

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  if (!data.scheduler_enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scheduler disabled</CardTitle>
          <CardDescription>
            Background tasks are turned off (SCHEDULER_ENABLED=false) or the
            scheduler did not start. Enable it and restart to see jobs here.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scheduled tasks</CardTitle>
        <CardDescription>
          Background jobs run by APScheduler. Last-run info resets on app restart.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="align-top">
                  <div className="font-medium">{job.name}</div>
                  <div className="text-xs text-muted-foreground">{job.trigger}</div>
                </TableCell>
                <TableCell className="align-top">
                  <StatusCell job={job} />
                </TableCell>
                <TableCell className="align-top">
                  <LastRunCell job={job} />
                </TableCell>
                <TableCell className="align-top text-sm">
                  {job.next_run_time ? relativeTime(job.next_run_time) : "paused"}
                </TableCell>
                <TableCell className="align-top">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={job.running || runJob.isPending}
                    onClick={() => runJob.mutate(job.id)}
                  >
                    <Play className="h-3.5 w-3.5 mr-1.5" />
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
