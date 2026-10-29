import { Link } from "@tanstack/react-router"
import {
  Activity,
  CalendarClock,
  Database,
  Globe,
  MapPin,
  Network,
  Radio,
  ShieldCheck,
  ShieldUser,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  useCrowdsecStats,
  useCrowdsecStatus,
  useDatabaseInfo,
  useHealth,
  useInstances,
  useLogFiles,
  useMe,
  useDeleteServerLocation,
  useOidcStatus,
  useRecentErrors,
  useSchedulerJobs,
  useServerLocations,
  useStats,
} from "@/lib/queries"
import { useLiveEvents, useLiveFeedStatus } from "@/lib/live-feed-context"
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
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip, StateLine, StatusLed } from "@/components/settings/status-led"
import { StatusPhone, type StatusTile } from "@/components/settings/status-phone"
import { useIsMobile } from "@/hooks/use-mobile"
import { agentAdvisoryCards, agentsNeedingAttention, agentSummary } from "@/components/settings/agents-logic"
import {
  accessLogFiles,
  accessLogUnavailableLabel,
  advisoryCards,
  agentMoreProblemsText,
  authState,
  type CardState,
  compressionSummary,
  crowdsecState,
  databaseState,
  filterErrorRecords,
  formatApproxRows,
  formatSize,
  formatUptime,
  geoipState,
  ingestionState,
  lastEventState,
  liveFeedState,
  loginMethodBadges,
  oidcState,
  overallState,
  recentErrorsFillsRow,
  relativeTime,
  schedulerJobState,
  schedulerSummary,
  statusProblems,
  verdictTitle,
  type ServerLocationRow,
  serverLocationRows,
} from "@/components/settings/status-logic"

export function SectionIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
      <Icon className="h-4 w-4 text-primary" />
    </div>
  )
}

function Counter({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">
        {value === undefined ? "-" : value.toLocaleString()}
      </span>
    </div>
  )
}

/** Settings > Status: per-component health so a sidebar "Degraded" state is
 *  explainable in-app. Read-only; each card degrades independently. */
/** One server location line. Auto rows can be removed (a retired server's
 *  beacon otherwise stays on the map forever); override rows point at the env
 *  var that owns them. */
function ServerLocationLine({ row }: { row: ServerLocationRow }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteServerLocation()
  // On a phone this line sits in a vaul drawer, whose bundled Radix copy
  // keeps focus out of a nested AlertDialog, so the confirmation is inline.
  const isMobile = useIsMobile()
  const removeLocation = () => remove.mutate(row.server, { onSettled: () => setConfirming(false) })
  // The inline confirmation stays open on a failed removal, so it can say so,
  // and puts focus on Keep, since disabling Remove while it ran dropped it.
  // A 404 means the location is already gone, which is what was asked for.
  const keepRef = useRef<HTMLButtonElement>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const removeLocationInline = () => {
    setRemoveError(null)
    remove.mutate(row.server, {
      onSuccess: () => setConfirming(false),
      onError: (error) => {
        // The generated client throws the parsed error body.
        const status =
          typeof error === "object" && error !== null && "status_code" in error ? error.status_code : undefined
        if (status === 404) {
          setConfirming(false)
          return
        }
        setRemoveError(
          status === 409
            ? `${row.server}'s location is now pinned by MAP_SERVER_LOCATIONS. Edit it there.`
            : "The location could not be removed. Try again.",
        )
        requestAnimationFrame(() => keepRef.current?.focus())
      },
    })
  }
  // Focus goes back to the trash button when the inline confirmation closes;
  // otherwise the drawer's focus trap drops it at the top of the drawer.
  const trashRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (wasConfirming.current && !confirming && isMobile) trashRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming, isMobile])
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <MonoChip>{row.server}</MonoChip>
      <span className="text-muted-foreground tabular-nums">{row.coords}</span>
      <span className={cn("tabular-nums", row.stale ? "text-amber-500" : "text-muted-foreground")}>
        {row.lastSeen}
      </span>
      {row.source === "override" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="ml-auto">
              override
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Pinned by MAP_SERVER_LOCATIONS; edit it there.</TooltipContent>
        </Tooltip>
      ) : (
        <>
          <span className="ml-auto text-muted-foreground">auto</span>
          <Button
            ref={trashRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove location for ${row.server}`}
            className="text-muted-foreground hover:text-destructive"
            // Reopening mid-request would reset the mutation and lose its outcome.
            disabled={remove.isPending}
            onClick={() => {
              setRemoveError(null)
              setConfirming(true)
            }}
          >
            <Trash2 />
          </Button>
          {isMobile && confirming && (
            <div
              role="group"
              aria-label={`Remove the location for ${row.server}?`}
              className="basis-full space-y-2 rounded-md border border-border/60 p-2"
            >
              <p className="text-muted-foreground">
                Remove the location for {row.server}? Its beacon leaves the map and live routes stop
                flying to it. If an agent still ingests as {row.server}, the location comes back at that
                agent's next refresh.
              </p>
              {removeError && (
                <p role="alert" className="text-destructive">
                  {removeError}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  ref={keepRef}
                  type="button"
                  size="sm"
                  variant="outline"
                  autoFocus
                  // Closing mid-request would hide whether the removal worked.
                  disabled={remove.isPending}
                  onClick={() => setConfirming(false)}
                >
                  Keep
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={removeLocationInline}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
          <AlertDialog open={!isMobile && confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the location for {row.server}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its beacon leaves the map and live routes stop flying to it. If an agent still
                  ingests as {row.server}, the location comes back at that agent's next refresh.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={removeLocation}
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}

export function StatusOverview() {
  const { data: health, isError: healthError, isLoading: healthLoading } = useHealth()
  const { data: stats, isError: statsError } = useStats()
  const { data: crowdsec, isError: crowdsecError } = useCrowdsecStatus()
  const { data: me, isError: meError } = useMe()
  const { data: oidc, isError: oidcError } = useOidcStatus()
  const { data: crowdsecStats } = useCrowdsecStats()
  const { data: files, isError: filesError } = useLogFiles()
  const { data: schedulerData, isError: jobsError } = useSchedulerJobs()
  const jobs = schedulerData?.jobs
  const { data: dbInfo } = useDatabaseInfo()
  const { data: logRecords, isError: logsError } = useRecentErrors()
  const { data: serverLocations } = useServerLocations()
  const { data: instances, isError: instancesError } = useInstances()
  const feedStatus = useLiveFeedStatus()
  const isMobile = useIsMobile()
  // Probe the live WebSocket while this page is open: the client is
  // per-tab and lazy, so without our own subscription the card could
  // never read anything but disconnected. Last unsubscriber closes it.
  useLiveEvents(() => {}, true)

  const now = Date.now()
  const access = accessLogFiles(files)
  const lokiSources = stats?.lokiSources ?? []
  const uptime = formatUptime(health?.startedAt, now)
  const geoipRefreshJob = jobs?.find((j) => j.id === "geoip-refresh")
  const recentErrors = filterErrorRecords(logRecords, 5)
  const locationRows = serverLocationRows(serverLocations, now)
  const oidcLine = oidcState(oidc, oidcError)
  // The summary uses the cached answer so the Agents card stays put through a
  // failed refetch; the advisory cards do not, since that answer may be stale.
  const agentOverview = agentSummary(instances)
  const agentCards = instancesError ? [] : agentAdvisoryCards(instances)
  const overall = overallState(health, healthError, instancesError ? 0 : agentsNeedingAttention(instances).length)
  const bottomCardsBefore = (agentOverview ? 1 : 0) + (locationRows.length > 0 ? 1 : 0)

  // Card bodies, shared by the desktop cards and the phone tiles' drawers.
  const authBody = (
    <>
      <StateLine state={authState(me, meError)} />
      {me?.mode === "session" && (
        <p className="text-xs text-muted-foreground">
          User <MonoChip>{me.username}</MonoChip>
        </p>
      )}
      {oidcLine && <StateLine state={oidcLine} />}
      {oidc?.configured && (
        <p className="text-xs text-muted-foreground">
          {oidc.providerName} <MonoChip>{oidc.issuer}</MonoChip>
        </p>
      )}
      {oidc?.configured && (
        <div className="flex items-center gap-2">
          {loginMethodBadges(oidc).map((label) => (
            <Badge key={label} variant="outline">
              {label}
            </Badge>
          ))}
        </div>
      )}
    </>
  )
  const ingestionBody = (
    <>
      <StateLine state={ingestionState(health, healthError)} />
      {statsError ? (
        <p className="text-xs text-muted-foreground">Statistics unavailable.</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          <Counter label="Parsed lines" value={stats?.totalParsedLines} />
          <Counter label="Processed" value={stats?.totalProcessed} />
          <Counter label="Skipped lines" value={stats?.totalSkippedLines} />
          <Counter label="Ignored lines" value={stats?.totalIgnoredLines} />
          <Counter label="Pending records" value={stats?.totalPendingRecords} />
          {(health?.ingestion.failedBatches ?? 0) > 0 && (
            <Counter label="Failed batches" value={health?.ingestion.failedBatches} />
          )}
          {(health?.ingestion.failedRecords ?? 0) > 0 && (
            <Counter label="Dropped records" value={health?.ingestion.failedRecords} />
          )}
        </div>
      )}
      {health && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Last event</span>
          {(() => {
            const state = lastEventState(
              health.ingestion.lastRecordAt,
              health.ingestion.running,
              now,
            )
            return (
              <>
                <StatusLed tone={state.tone} />
                <span className="font-medium">{state.label}</span>
                {state.detail && (
                  <span className="text-muted-foreground">{state.detail}</span>
                )}
              </>
            )
          })()}
        </div>
      )}
      {/* A disabled parser tails nothing by design, so the file list
          (which would only say "No access logs configured.") is noise. */}
      {health?.ingestion.status !== "disabled" && (
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">Access log sources</p>
        {filesError && <p className="text-xs text-muted-foreground">File list unavailable.</p>}
        {!filesError && stats !== undefined && !statsError && access.length === 0 && lokiSources.length === 0 && (
          <p className="text-xs text-muted-foreground">No access logs configured.</p>
        )}
        {access.map((f) => (
          <div key={f.name} className="flex items-center gap-2 text-xs">
            <StatusLed tone={f.available ? "emerald" : "red"} />
            <MonoChip>{f.name}</MonoChip>
            {f.available ? (
              <span className="ml-auto text-muted-foreground tabular-nums">
                {formatSize(f.sizeBytes)}
                {f.modifiedAt && ` · ${new Date(f.modifiedAt).toLocaleString()}`}
              </span>
            ) : (
              <span className="ml-auto text-red-500">{accessLogUnavailableLabel(f, health)}</span>
            )}
          </div>
        ))}
        {lokiSources.map((source) => (
          <div key={source.label} className="flex items-center gap-2 text-xs">
            <StatusLed tone={source.available ? "emerald" : "red"} />
            <MonoChip>{source.query}</MonoChip>
            <span className="text-muted-foreground">{source.server}</span>
            <span className="ml-auto text-muted-foreground tabular-nums">
              {source.logFormat ?? "format pending"} · {source.parsedLines.toLocaleString()} lines
              {!source.available && (
                <span className="ml-2 text-red-500">
                  {source.reason === "rejected" ? "rejected" : "unreachable"}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      )}
    </>
  )
  const databaseBody = (
    <>
      <StateLine state={databaseState(health)} />
      {dbInfo?.reachable && (
        <>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {dbInfo.sizeBytes !== null && (
                <span className="font-medium text-foreground">
                  {formatSize(dbInfo.sizeBytes)}
                </span>
              )}{" "}
              total · PostgreSQL {dbInfo.postgresVersion?.split(" ")[0]} · TimescaleDB{" "}
              {dbInfo.timescaledbVersion}
            </p>
            <p>
              Raw events kept {dbInfo.retentionDays} days, debug lines{" "}
              {dbInfo.debugRetentionDays} days
            </p>
            {compressionSummary(dbInfo.hypertables) && (
              <p>Compression {compressionSummary(dbInfo.hypertables)}</p>
            )}
          </div>
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Hypertables</p>
            {dbInfo.hypertables.map((t) => (
              <div key={t.name} className="flex items-center gap-2 text-xs">
                <MonoChip>{t.name}</MonoChip>
                <span className="ml-auto text-muted-foreground tabular-nums">
                  ~{formatApproxRows(t.approxRows)} rows
                  {t.totalBytes !== null && ` · ${formatSize(t.totalBytes)}`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
  const geoipBody = (
    <>
      <StateLine state={geoipState(health)} />
      <div className="space-y-1 text-xs text-muted-foreground">
        {health?.geoip.dbBuildDate && (
          <p>City database built {relativeTime(health.geoip.dbBuildDate, now)}</p>
        )}
        {health?.geoip.asnAvailable && health.geoip.asnDbBuildDate && (
          <p>ASN database built {relativeTime(health.geoip.asnDbBuildDate, now)}</p>
        )}
        {geoipRefreshJob?.nextRunTime && (
          <p>Next refresh {relativeTime(geoipRefreshJob.nextRunTime, now)}</p>
        )}
      </div>
    </>
  )
  const crowdsecBody = (
    <>
      <StateLine state={crowdsecState(crowdsec, crowdsecError)} />
      {crowdsec?.enabled && !crowdsec.liveUpdates && (
        <p className="text-xs text-muted-foreground">Live updates paused</p>
      )}
      <div className="flex items-center gap-2">
        {crowdsec?.enabled && (
          <Badge variant="outline">
            {crowdsec.writeEnabled ? "write enabled" : "read only"}
          </Badge>
        )}
        {crowdsecStats && (
          <Link
            to="/security"
            className="tap-area text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {crowdsecStats.total.toLocaleString()} active decisions
          </Link>
        )}
      </div>
    </>
  )
  const schedulerBody = (
    <>
      {jobsError && <p className="text-xs text-muted-foreground">Job list unavailable.</p>}
      {jobs?.map((job) => {
        const state = schedulerJobState(job)
        return (
          <div key={job.id} className="flex items-center gap-2 text-xs">
            <StatusLed tone={state.tone} pulse={job.running} />
            <span className="font-medium">{job.name}</span>
            <span className="ml-auto text-muted-foreground">
              {job.running
                ? "running"
                : job.nextRunTime
                  ? `next ${relativeTime(job.nextRunTime, now)}`
                  : state.label}
            </span>
          </div>
        )
      })}
    </>
  )
  const liveFeedBody = (
    <>
      <StateLine state={liveFeedState(feedStatus)} />
    </>
  )
  const agentsBody = agentOverview && (
    <>
      {instancesError ? (
        <div className="flex items-center gap-2">
          <StatusLed tone="muted" />
          <span className="text-sm font-medium">Agent list unavailable</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <StatusLed tone={agentOverview.tone} pulse={agentOverview.tone === "emerald"} />
          <Link
            to="/settings/agents"
            className="tap-area text-sm font-medium underline underline-offset-2"
          >
            {agentOverview.line}
          </Link>
        </div>
      )}
    </>
  )
  const locationsBody = (
    <>
      {locationRows.map((row) => (
        <ServerLocationLine key={row.server} row={row} />
      ))}
    </>
  )
  const recentErrorsBody = (
    <>
      {logsError && <p className="text-xs text-muted-foreground">Log tail unavailable.</p>}
      {!logsError && recentErrors.length === 0 && (
        <p className="text-xs text-muted-foreground">No recent errors.</p>
      )}
      {recentErrors.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {r.timestamp ? new Date(r.timestamp).toLocaleString() : ""}
          </span>
          {r.logger && <MonoChip>{r.logger}</MonoChip>}
          <span className="truncate">{r.event}</span>
        </div>
      ))}
    </>
  )

  if (healthLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (isMobile) {
    const problems = statusProblems(advisoryCards(health), agentCards)
    const errorsState: CardState = logsError
      ? { tone: "muted", label: "Unavailable" }
      : recentErrors.length > 0
        ? { tone: "amber", label: `${recentErrors.length} recent` }
        : { tone: "emerald", label: "None" }
    const tiles: StatusTile[] = [
      {
        id: "auth",
        icon: ShieldUser,
        title: "Authentication",
        state: authState(me, meError),
        sub: me?.mode === "session" ? `User ${me.username}` : undefined,
        body: authBody,
      },
      {
        id: "ingestion",
        icon: Activity,
        title: "Ingestion",
        description: "Access log tailing and parsing pipeline",
        state: ingestionState(health, healthError),
        sub: stats && !statsError ? `${stats.totalParsedLines.toLocaleString()} lines parsed` : undefined,
        body: ingestionBody,
      },
      {
        id: "database",
        icon: Database,
        title: "Database",
        description: "TimescaleDB connection",
        state: databaseState(health),
        sub: dbInfo?.sizeBytes != null ? formatSize(dbInfo.sizeBytes) : undefined,
        body: databaseBody,
      },
      {
        id: "geoip",
        icon: Globe,
        title: "GeoIP",
        description: "MaxMind GeoLite2 databases",
        state: geoipState(health),
        sub: health?.geoip.dbBuildDate ? `City built ${relativeTime(health.geoip.dbBuildDate, now)}` : undefined,
        body: geoipBody,
      },
      {
        id: "crowdsec",
        icon: ShieldCheck,
        title: "CrowdSec",
        description: "LAPI integration for viewing and managing bans",
        state: crowdsecState(crowdsec, crowdsecError),
        sub: crowdsecStats ? `${crowdsecStats.total.toLocaleString()} decisions` : undefined,
        body: crowdsecBody,
      },
      (() => {
        const state = schedulerSummary(jobs, jobsError, now)
        return {
          id: "scheduler",
          icon: CalendarClock,
          title: "Scheduler",
          description: "Background jobs",
          state: { tone: state.tone, label: state.label },
          sub: state.detail,
          body: schedulerBody,
          link: { to: "/settings/scheduler", label: "Open Scheduler" },
        }
      })(),
      {
        id: "live-feed",
        icon: Radio,
        title: "Live feed",
        description: "WebSocket stream for the map and live views, probed while this page is open",
        state: liveFeedState(feedStatus),
        body: liveFeedBody,
      },
      ...(agentOverview
        ? [
            {
              id: "agents",
              icon: Network,
              title: "Agents",
              description: "Other instances writing to this database",
              state: instancesError
                ? ({ tone: "muted", label: "Unavailable" } as const)
                : { tone: agentOverview.tone, label: agentOverview.line },
              body: agentsBody,
            },
          ]
        : []),
      ...(locationRows.length > 0
        ? [
            {
              id: "locations",
              icon: MapPin,
              title: "Server locations",
              description: "Where each server sits on the map and where its live routes land",
              state: {
                tone: "emerald",
                label: locationRows.length === 1 ? "1 server" : `${locationRows.length} servers`,
              } as const,
              body: locationsBody,
            },
          ]
        : []),
      {
        id: "recent-errors",
        icon: TriangleAlert,
        title: "Recent errors",
        description: "Latest error-level events from the application log",
        state: errorsState,
        body: recentErrorsBody,
        link: { to: "/settings/logs", label: "Open Logs" },
      },
    ]
    return (
      <StatusPhone
        verdict={{
          tone: overall.tone,
          title: verdictTitle(overall, problems.length),
          detail: overall.detail,
          meta: health
            ? [uptime, `Updated ${new Date(health.timestamp).toLocaleTimeString()}`].filter(Boolean).join(" · ")
            : undefined,
        }}
        problems={problems}
        tiles={tiles}
      />
    )
  }

  return (
    <div className="space-y-4">
      {advisoryCards(health).map((card) => (
        <Card key={card.id} className={cn("border-l-2", card.tone === "red" ? "border-l-red-500" : "border-l-amber-500")}>
          <CardContent className="space-y-1 pt-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusLed tone={card.tone} />
              {card.label}
            </div>
            {card.detail && <p className="text-xs text-muted-foreground">{card.detail}</p>}
            {card.remedy && (
              <code className="block w-fit whitespace-pre-line rounded bg-muted px-2 py-1 text-xs">{card.remedy}</code>
            )}
            {card.docsUrl && (
              <a
                href={card.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="tap-area text-xs text-primary underline underline-offset-2"
              >
                Setup guide
              </a>
            )}
          </CardContent>
        </Card>
      ))}

      {agentCards.map((card) => {
        const moreProblems = agentMoreProblemsText(card.moreCount)
        return (
          <Card
            key={`agent-${card.instanceName}`}
            className={cn("border-l-2", card.tone === "red" ? "border-l-red-500" : "border-l-amber-500")}
          >
            <CardContent className="space-y-1 pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <StatusLed tone={card.tone} />
                {card.summary}
              </div>
              <p className="text-xs text-muted-foreground">
                {moreProblems && `${moreProblems} `}
                <Link
                  to="/settings/agents"
                  search={{ instance: card.instanceName }}
                  className="tap-area text-primary underline underline-offset-2"
                >
                  Open {card.instanceName} on the Agents page
                </Link>
              </p>
            </CardContent>
          </Card>
        )
      })}

      {/* Overall state and Authentication share the banner row: the subsystem
          grid below holds an even number of cards, so putting Authentication
          there instead would leave a hole in its last row. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <StatusLed tone={overall.tone} pulse={overall.tone !== "muted"} />
                <CardTitle>{overall.label}</CardTitle>
              </div>
              {health && (
                <span className="text-xs text-muted-foreground">
                  {uptime && `${uptime} · `}
                  Updated {new Date(health.timestamp).toLocaleTimeString()}
                </span>
              )}
            </div>
            {overall.detail && <CardDescription>{overall.detail}</CardDescription>}
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={ShieldUser} />
              <CardTitle className="text-base">Authentication</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {authBody}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Activity} />
              <div>
                <CardTitle className="text-base">Ingestion</CardTitle>
                <CardDescription>Access log tailing and parsing pipeline</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {ingestionBody}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Database} />
              <div>
                <CardTitle className="text-base">Database</CardTitle>
                <CardDescription>TimescaleDB connection</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {databaseBody}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Globe} />
              <div>
                <CardTitle className="text-base">GeoIP</CardTitle>
                <CardDescription>MaxMind GeoLite2 databases</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {geoipBody}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={ShieldCheck} />
              <div>
                <CardTitle className="text-base">CrowdSec</CardTitle>
                <CardDescription>LAPI integration for viewing and managing bans</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {crowdsecBody}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={CalendarClock} />
              <div>
                <CardTitle className="text-base">Scheduler</CardTitle>
                <CardDescription>
                  Background jobs ·{" "}
                  <Link to="/settings/scheduler" className="tap-area underline underline-offset-2">
                    details
                  </Link>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {schedulerBody}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Radio} />
              <div>
                <CardTitle className="text-base">Live feed</CardTitle>
                <CardDescription>
                  WebSocket stream for the map and live views, probed while this page is open
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {liveFeedBody}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {agentOverview && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <SectionIcon icon={Network} />
                <div>
                  <CardTitle className="text-base">Agents</CardTitle>
                  <CardDescription>Other instances writing to this database</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {agentsBody}
            </CardContent>
          </Card>
        )}

        {locationRows.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <SectionIcon icon={MapPin} />
                <div>
                  <CardTitle className="text-base">Server locations</CardTitle>
                  <CardDescription>Where each server sits on the map and where its live routes land</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {locationsBody}
            </CardContent>
          </Card>
        )}

        <Card className={recentErrorsFillsRow(bottomCardsBefore) ? "md:col-span-2" : undefined}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={TriangleAlert} />
              <div>
                <CardTitle className="text-base">Recent errors</CardTitle>
                <CardDescription>
                  Latest error-level events from the application log ·{" "}
                  <Link to="/settings/logs" className="tap-area underline underline-offset-2">
                    open Logs
                  </Link>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentErrorsBody}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
