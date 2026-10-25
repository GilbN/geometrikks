import { Link } from "@tanstack/react-router"
import { ChevronRight, Network, Trash2 } from "lucide-react"
import { Fragment, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type {
  Advisory,
  HeadIdentityView,
  InstanceView,
  SourceReport,
} from "@/generated/api/types.gen"
import { useDeleteInstance, useInstances } from "@/lib/queries"
import { cn } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { type LedTone, MonoChip, StatusLed } from "@/components/settings/status-led"
import { formatUptime, relativeTime } from "@/components/settings/status-logic"
import { SectionIcon } from "@/components/settings/status-overview"
import {
  agentIngestionState,
  agentInstances,
  canRemove,
  instanceStatusLabel,
  instanceTone,
  instancesErrorState,
  jobReportState,
  schemaWaitState,
  sourceReasonLabel,
  versionText,
  versionTone,
} from "@/components/settings/agents-logic"

const AGENT_DOCS_URL = "https://github.com/GilbN/geometrikks/blob/main/README.md#multi-source-setup"

const COLUMN_COUNT = 7

function formatDateTime(iso: string): string {
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>
}

function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">{children}</dl>
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 tabular-nums">{children}</dd>
    </>
  )
}

function LedValue({ tone, children }: { tone: LedTone; children: React.ReactNode }) {
  return (
    <>
      <StatusLed tone={tone} />
      <span className="truncate">{children}</span>
    </>
  )
}

function ProblemLine({ problem }: { problem: Advisory }) {
  const tone = problem.severity === "critical" ? "red" : "amber"
  return (
    <div
      className={cn(
        "space-y-1 rounded-md border-l-2 bg-muted/40 px-3 py-2",
        tone === "red" ? "border-l-red-500" : "border-l-amber-500",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <StatusLed tone={tone} />
        {problem.summary}
      </div>
      {problem.detail && <p className="text-xs text-muted-foreground">{problem.detail}</p>}
      {problem.remedy && (
        <code className="block w-fit whitespace-pre-line rounded bg-muted px-2 py-1 text-xs">{problem.remedy}</code>
      )}
      {problem.docsUrl && (
        <a
          href={problem.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline underline-offset-2"
        >
          Setup guide
        </a>
      )}
    </div>
  )
}

function SourceLine({ source }: { source: SourceReport }) {
  const details = [source.logFormat || "format pending", source.serverName && `server ${source.serverName}`]
    .filter(Boolean)
    .join(" · ")
  return (
    <div className="flex items-center gap-2 text-xs">
      <StatusLed tone={source.available ? "emerald" : "red"} />
      <MonoChip className="truncate">{source.label || "unnamed source"}</MonoChip>
      {source.kind === "loki" && <Badge variant="outline">Loki</Badge>}
      <span className="text-muted-foreground">{details}</span>
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {(source.parsedLines ?? 0).toLocaleString()} lines
        {!source.available && <span className="ml-2 text-red-500">{sourceReasonLabel(source.reason)}</span>}
      </span>
    </div>
  )
}

function InstanceDetail({ instance, now, checkedAt }: { instance: InstanceView; now: number; checkedAt: number }) {
  const health = instance.health
  const payload = instance.payload
  const schemaWait = schemaWaitState(health?.schemaWait)
  const ingestion = agentIngestionState(health?.ingestion, payload?.failed5M)
  const uptime = instance.checkingIn ? formatUptime(instance.startedAt, now) : null
  const jobs = payload?.jobs ?? []
  const sources = payload?.sources ?? []
  const lastError = payload?.lastError
  const nameSource = payload?.instanceNameSource

  return (
    <div className="space-y-4 py-2 whitespace-normal">
      {!instance.checkingIn && (
        <p className="text-xs text-muted-foreground">
          These details come from its last heartbeat, {relativeTime(instance.lastSeen, checkedAt)}.
        </p>
      )}

      <div className="space-y-2">
        <SectionHeading>Problems</SectionHeading>
        {instance.problems.length === 0 ? (
          <p className="text-xs text-muted-foreground">No problems.</p>
        ) : (
          instance.problems.map((problem) => <ProblemLine key={problem.id} problem={problem} />)
        )}
      </div>

      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <div className="space-y-2">
          <SectionHeading>Instance</SectionHeading>
          <Facts>
            <Fact label="Mode">{instance.mode}</Fact>
            <Fact label="Started">
              {formatDateTime(instance.startedAt)}
              {uptime && <span className="text-muted-foreground">{uptime}</span>}
            </Fact>
            <Fact label="Migration">
              <MonoChip>{instance.schemaRevision}</MonoChip>
            </Fact>
            {nameSource === "fallback" && <Fact label="Name">default name, APP_INSTANCE_NAME not set</Fact>}
            {schemaWait && (
              <Fact label="Schema check">
                <LedValue tone={schemaWait.tone}>{schemaWait.label}</LedValue>
              </Fact>
            )}
            {health && (
              <Fact label="Database">
                <LedValue tone={health.database.reachable ? "emerald" : "red"}>
                  {health.database.reachable ? "reachable" : "unreachable"}
                </LedValue>
              </Fact>
            )}
          </Facts>
        </div>

        <div className="space-y-2">
          <SectionHeading>Ingestion</SectionHeading>
          {health ? (
            <Facts>
              <Fact label="Status">
                <LedValue tone={ingestion.tone}>{ingestion.label}</LedValue>
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
          ) : (
            <p className="text-xs text-muted-foreground">
              The head can't read this agent's health report. Run the same version on both.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <SectionHeading>GeoIP</SectionHeading>
          {health ? (
            <Facts>
              <Fact label="City">
                <LedValue tone={health.geoip.available ? "emerald" : "red"}>
                  {health.geoip.available
                    ? health.geoip.dbBuildDate
                      ? `built ${formatDate(health.geoip.dbBuildDate)}, ${relativeTime(health.geoip.dbBuildDate, now)}`
                      : "loaded"
                    : "not loaded"}
                </LedValue>
              </Fact>
              <Fact label="ASN">
                <LedValue tone={health.geoip.asnAvailable ? "emerald" : "muted"}>
                  {health.geoip.asnAvailable
                    ? health.geoip.asnDbBuildDate
                      ? `built ${formatDate(health.geoip.asnDbBuildDate)}, ${relativeTime(health.geoip.asnDbBuildDate, now)}`
                      : "loaded"
                    : "not loaded"}
                </LedValue>
              </Fact>
            </Facts>
          ) : (
            <p className="text-xs text-muted-foreground">
              The head can't read this agent's health report. Run the same version on both.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <SectionHeading>Scheduled jobs</SectionHeading>
          {jobs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No scheduled jobs reported.</p>
          ) : (
            <Facts>
              {jobs.map((job, jobIndex) => {
                const state = jobReportState(job)
                const lastRun = job.lastStart ? `${state.label} ${relativeTime(job.lastStart, now)}` : state.label
                const nextRun = job.nextRunTime ? `, next ${relativeTime(job.nextRunTime, now)}` : ""
                return (
                  <Fragment key={job.id || jobIndex}>
                    <Fact label={job.name || job.id || "unnamed job"}>
                      <LedValue tone={state.tone}>
                        {lastRun}
                        {nextRun}
                      </LedValue>
                    </Fact>
                    {job.lastError && (
                      <dd className="col-start-2 truncate text-muted-foreground" title={job.lastError}>
                        {job.lastError}
                      </dd>
                    )}
                  </Fragment>
                )
              })}
            </Facts>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeading>Sources</SectionHeading>
        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">No log sources reported.</p>
        ) : (
          sources.map((source, sourceIndex) => (
            <SourceLine key={`${source.kind}:${source.label}:${sourceIndex}`} source={source} />
          ))
        )}
      </div>

      <div className="space-y-2">
        <SectionHeading>Server locations</SectionHeading>
        {instance.serverLocations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No location recorded for its servers yet.</p>
        ) : (
          instance.serverLocations.map((serverLocation) => (
            <div key={serverLocation.server} className="flex items-center gap-2 text-xs">
              <MonoChip>{serverLocation.server}</MonoChip>
              <span className="text-muted-foreground tabular-nums">
                {serverLocation.latitude.toFixed(2)}, {serverLocation.longitude.toFixed(2)}
              </span>
              <span className="ml-auto text-muted-foreground">
                {serverLocation.source}
                {serverLocation.detectedAt && `, detected ${relativeTime(serverLocation.detectedAt, now)}`}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2">
        <SectionHeading>Last error</SectionHeading>
        {lastError?.message ? (
          <div className="space-y-1">
            <pre className="whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1.5 font-mono text-[11px] text-red-600 dark:text-red-300">
              {lastError.message}
            </pre>
            {lastError.at && (
              <p className="text-xs text-muted-foreground">{formatDateTime(lastError.at)}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No failed writes since it started.</p>
        )}
      </div>
    </div>
  )
}

function RemoveInstanceButton({
  instanceName,
  onRemoved,
}: {
  instanceName: string
  onRemoved: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const removedRef = useRef(false)
  const deleteInstanceMutation = useDeleteInstance()
  const pending = deleteInstanceMutation.isPending
  // React bubbles events out of the dialog's portal along the component
  // tree, so without this span every click in the dialog toggles the row.
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${instanceName}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // The trigger leaves with the removed row; focus the table heading instead.
            if (!removedRef.current) return
            event.preventDefault()
            onRemoved()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {instanceName} from the list?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its heartbeat row. If {instanceName} is still running somewhere, it writes
              the row again within 30 seconds and comes back here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                // Stay open while the request runs; success closes it, failure leaves it up to retry.
                event.preventDefault()
                deleteInstanceMutation.mutate(instanceName, {
                  onSuccess: () => {
                    removedRef.current = true
                    setConfirming(false)
                  },
                  onError: () => toast.error(`Could not remove ${instanceName}. Try again.`),
                })
              }}
            >
              {pending ? "Removing" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  )
}

function FiveMinuteCell({ instance }: { instance: InstanceView }) {
  const lines = instance.payload?.lines5M
  const failed = instance.payload?.failed5M
  if (lines === null || lines === undefined) {
    return (
      <span className="text-muted-foreground" title="Needs 5 minutes of heartbeats">
        <span aria-hidden="true">-</span>
        <span className="sr-only">Needs 5 minutes of heartbeats</span>
      </span>
    )
  }
  return (
    <span className="tabular-nums">
      {lines.toLocaleString()}
      {(failed ?? 0) > 0 && <span className="text-red-500">, {failed?.toLocaleString()} failed</span>}
    </span>
  )
}

function InstanceRows({
  instance,
  head,
  open,
  onOpenChange,
  now,
  checkedAt,
  rowRef,
  onRemoved,
}: {
  instance: InstanceView
  head: HeadIdentityView
  open: boolean
  onOpenChange: (open: boolean) => void
  now: number
  checkedAt: number
  rowRef?: React.Ref<HTMLTableRowElement>
  onRemoved: () => void
}) {
  const drift = versionTone(instance, head)
  const driftText =
    drift === "red"
      ? "built for a different migration than the head"
      : drift === "amber"
        ? "a different version than the head"
        : null
  const serverNames = instance.payload?.serverNames ?? []
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <TableBody className="border-b last:border-b-0">
        <TableRow ref={rowRef} className="cursor-pointer" onClick={() => onOpenChange(!open)}>
          <TableCell className="w-6">
            <StatusLed tone={instanceTone(instance)} />
            <span className="sr-only">{instanceStatusLabel(instance.status)}</span>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                  <MonoChip className="text-foreground">{instance.instanceName}</MonoChip>
                </button>
              </CollapsibleTrigger>
              {instance.isSelf && (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  this instance
                </Badge>
              )}
            </div>
          </TableCell>
          <TableCell
            className={cn(
              "tabular-nums",
              drift === "red" && "text-red-500",
              drift === "amber" && "text-amber-500",
            )}
          >
            <span title={driftText ?? undefined}>{versionText(instance.appVersion)}</span>
            {driftText && <span className="sr-only">, {driftText}</span>}
          </TableCell>
          <TableCell className="hidden text-muted-foreground md:table-cell">
            {serverNames.length > 0 ? serverNames.join(", ") : "-"}
          </TableCell>
          <TableCell className="hidden md:table-cell">
            <FiveMinuteCell instance={instance} />
          </TableCell>
          <TableCell className={cn("tabular-nums", instance.checkingIn ? "text-muted-foreground" : "text-red-500")}>
            <span title={instance.checkingIn ? undefined : "Not checking in"}>
              {relativeTime(instance.lastSeen, checkedAt)}
            </span>
            {!instance.checkingIn && <span className="sr-only">, not checking in</span>}
          </TableCell>
          <TableCell className="w-8 text-right">
            {canRemove(instance) && (
              <RemoveInstanceButton instanceName={instance.instanceName} onRemoved={onRemoved} />
            )}
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <TableRow className="bg-muted/20 hover:bg-muted/20">
            <TableCell />
            <TableCell colSpan={COLUMN_COUNT - 1} className="pr-4">
              <InstanceDetail instance={instance} now={now} checkedAt={checkedAt} />
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </TableBody>
    </Collapsible>
  )
}

export function AgentsOverview({ focusInstance }: { focusInstance?: string }) {
  const { data, isError } = useInstances()
  const state = instancesErrorState(isError, data)
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(focusInstance ? [focusInstance] : []),
  )
  const focusRowRef = useRef<HTMLTableRowElement>(null)
  const scrolledToFocus = useRef(false)
  const headingRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focusInstance) return
    setExpanded((previous) => (previous.has(focusInstance) ? previous : new Set(previous).add(focusInstance)))
    scrolledToFocus.current = false
  }, [focusInstance])

  useEffect(() => {
    if (state !== "ready" || scrolledToFocus.current || !focusRowRef.current) return
    scrolledToFocus.current = true
    focusRowRef.current.scrollIntoView({ block: "start" })
  }, [state, focusInstance])

  if (state === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (state === "error" || !data) {
    return (
      <Card className="border-l-2 border-l-red-500">
        <CardContent className="space-y-1 pt-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <StatusLed tone="red" />
            Could not load the agent list.
          </div>
          <p className="text-xs text-muted-foreground">
            The request failed, so this page cannot tell which agents are checking in. If the
            database is down,{" "}
            <Link to="/settings/status" className="underline underline-offset-2">
              Settings &gt; Status
            </Link>{" "}
            says so. This page tries again every 30 seconds.
          </p>
        </CardContent>
      </Card>
    )
  }

  const now = Date.now()
  const checkedAt = Date.parse(data.checkedAt)
  const agentCount = agentInstances(data).length
  const setInstanceOpen = (instanceName: string, open: boolean) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(instanceName)
      else next.delete(instanceName)
      return next
    })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <SectionIcon icon={Network} />
            <div>
              <CardTitle ref={headingRef} tabIndex={-1} className="text-base outline-none">
                Instances
              </CardTitle>
              <CardDescription>
                The head runs <MonoChip>{versionText(data.head.appVersion)}</MonoChip> on migration{" "}
                <MonoChip>{data.head.schemaRevision}</MonoChip>. Checked{" "}
                {new Date(data.checkedAt).toLocaleTimeString()}, refreshed every 30 seconds.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6">
                  <span className="sr-only">Status</span>
                </TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="hidden md:table-cell">Servers</TableHead>
                <TableHead className="hidden md:table-cell">Lines, last 5 min</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="w-8">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            {data.instances.map((instance) => (
              <InstanceRows
                key={instance.instanceName}
                instance={instance}
                head={data.head}
                open={expanded.has(instance.instanceName)}
                onOpenChange={(open) => setInstanceOpen(instance.instanceName, open)}
                now={now}
                checkedAt={checkedAt}
                rowRef={instance.instanceName === focusInstance ? focusRowRef : undefined}
                onRemoved={() => headingRef.current?.focus()}
              />
            ))}
          </Table>
        </CardContent>
      </Card>

      {agentCount === 0 && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm font-medium">No agents yet</p>
            <p className="text-xs text-muted-foreground">
              An agent is a GeoMetrikks container started with <MonoChip>APP_MODE=agent</MonoChip>{" "}
              on another host. It tails that host's proxy logs and writes to this database, so its
              traffic appears on the map and in analytics. Agents show up here once they run a
              release that writes heartbeats, within 30 seconds of starting.
            </p>
            <a
              href={AGENT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline underline-offset-2"
            >
              Set up an agent
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
