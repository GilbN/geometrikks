/** The desktop status board's rows: what each row says closed, and the panel
 *  it opens to. */
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
import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { HealthResponse, MeResponse, OidcStatus } from "@/lib/api"
import type {
  CrowdSecStatusResponse,
  LogFileView,
  SchedulerJobView,
} from "@/generated/api/types.gen"
import type { LogRecord } from "@/lib/logstream"
import type { LiveFeedStatus } from "@/lib/websocket"
import {
  queryKeys,
  useCrowdsecStats,
  useDatabaseInfo,
  useDeleteServerLocation,
  useStats,
} from "@/lib/queries"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MonoChip } from "@/components/settings/status-led"
import { cn } from "@/lib/utils"
import { RemoveLocationAlert } from "@/components/settings/status-remove-location"
import {
  BoardPanel,
  type BoardRowSpec,
  Cell,
  Cells,
  PanelCaption,
  PanelFooter,
  PanelLink,
  PanelSeparator,
  StatusBoard,
  Ticking,
  ToneLabel,
} from "@/components/settings/status-board"
import type { AgentSummary } from "@/components/settings/agents-logic"
import {
  accessLogUnavailableLabel,
  ageLabel,
  authState,
  boardVerdict,
  type CardState,
  clockOrDate,
  compressionRatio,
  compressionSummary,
  crowdsecState,
  databaseState,
  formatApproxRows,
  formatSize,
  formatUptime,
  geoipState,
  ingestionState,
  lastEventState,
  liveFeedState,
  locationsFact,
  locationsSource,
  nextSchedulerJob,
  oidcState,
  relativeTime,
  schedulerJobState,
  schedulerSummary,
  type ServerLocationRow,
  sourcesPhrase,
  unavailableSourceCount,
  unavailableSourcesWord,
  untilLabel,
} from "@/components/settings/status-logic"

type Stats = NonNullable<ReturnType<typeof useStats>["data"]>
type DatabaseInfo = NonNullable<ReturnType<typeof useDatabaseInfo>["data"]>
type CrowdsecStats = NonNullable<ReturnType<typeof useCrowdsecStats>["data"]>

export interface StatusData {
  health: HealthResponse | undefined
  healthError: boolean
  stats: Stats | undefined
  statsError: boolean
  crowdsec: CrowdSecStatusResponse | undefined
  crowdsecError: boolean
  crowdsecStats: CrowdsecStats | undefined
  me: MeResponse | undefined
  meError: boolean
  oidc: OidcStatus | undefined
  oidcError: boolean
  accessFiles: LogFileView[]
  filesError: boolean
  jobs: SchedulerJobView[] | undefined
  jobsError: boolean
  dbInfo: DatabaseInfo | undefined
  recentErrors: LogRecord[]
  logsError: boolean
  locationRows: ServerLocationRow[]
  agentOverview: AgentSummary | null
  instancesError: boolean
  feedStatus: LiveFeedStatus
  overall: CardState
}

/** Every query the Status page reads; Check now refetches them all. */
const STATUS_QUERY_KEYS: readonly (readonly unknown[])[] = [
  ["health"],
  queryKeys.system.stats,
  queryKeys.system.database,
  queryKeys.system.schedulerJobs,
  queryKeys.system.instances,
  queryKeys.crowdsec.status,
  queryKeys.crowdsec.stats,
  queryKeys.auth.me,
  queryKeys.auth.oidcStatus,
  queryKeys.logs.files,
  queryKeys.geo.serverLocations,
  ["logs", "recent-errors"],
]

const LIVE_FEED_GRACE_MS = 5_000

/** The live feed starts disconnected on every visit and drops for a moment on
 *  a reconnect, so it counts as a problem only after a few seconds of it. */
function useLiveFeedSettled(status: LiveFeedStatus): boolean {
  const down = status !== "connected"
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    setSettled(false)
    if (!down) return
    const id = setTimeout(() => setSettled(true), LIVE_FEED_GRACE_MS)
    return () => clearTimeout(id)
  }, [down])
  return down && settled
}

const dash = <span className="text-muted-foreground">-</span>

export function DesktopStatus({ data }: { data: StatusData }) {
  const queryClient = useQueryClient()
  const liveFeedSettled = useLiveFeedSettled(data.feedStatus)
  const now = Date.now()
  const { health } = data

  const rows: BoardRowSpec[] = [
    ingestionRow(data),
    databaseRow(data),
    geoipRow(data, now),
    crowdsecRow(data),
    schedulerRow(data, now),
    liveFeedRow(data, liveFeedSettled),
    authRow(data),
    ...(data.agentOverview ? [agentsRow(data, data.agentOverview)] : []),
    ...(data.locationRows.length > 0 ? [locationsRow(data.locationRows)] : []),
    recentErrorsRow(data),
  ]
  const verdict = boardVerdict(
    data.overall,
    rows.map((row) => ({ id: row.id, tone: row.state.tone, counts: row.counts })),
  )
  const startedAt = health?.startedAt
  const meta = health && (
    <>
      {startedAt && <Ticking render={(nowMs) => `${formatUptime(startedAt, nowMs)} · `} />}
      Updated {new Date(health.timestamp).toLocaleTimeString()}
    </>
  )
  const checkNow = () =>
    Promise.all(
      STATUS_QUERY_KEYS.map((queryKey) => queryClient.refetchQueries({ queryKey, type: "active" })),
    )
  return <StatusBoard verdict={verdict} meta={meta} rows={rows} onCheckNow={checkNow} />
}

function sinceStarted(startedAt: string | null | undefined) {
  if (!startedAt) return "Since the app started"
  return (
    <Ticking
      render={(nowMs) =>
        `Since the app started ${formatUptime(startedAt, nowMs)?.replace(/^up /, "")} ago`
      }
    />
  )
}

function ingestionRow(data: StatusData): BoardRowSpec {
  const { health, stats } = data
  const state = ingestionState(health, data.healthError)
  const disabled = health?.ingestion.status === "disabled"
  const lokiSources = stats?.lokiSources ?? []
  const total = data.accessFiles.length + lokiSources.length
  const lastRecordAt = health?.ingestion.lastRecordAt
  const unavailable = unavailableSourceCount(health)
  // The source count comes from the file list and stats, not /health, so it can lag
  // behind the unavailable count while they load.
  const sources = sourcesPhrase(
    Math.max(total, unavailable),
    unavailable,
    unavailableSourcesWord(health),
  )
  const fact = !health ? null : disabled ? (
    "Log tailing is turned off"
  ) : (
    <>
      {sources} · last event <Ticking render={(nowMs) => relativeTime(lastRecordAt, nowMs)} />
    </>
  )
  const running = health?.ingestion.running ?? false
  const failedBatches = health?.ingestion.failedBatches ?? 0
  const failedRecords = health?.ingestion.failedRecords ?? 0
  const panel = (
    <BoardPanel sentence={state.detail}>
      <PanelCaption>{sinceStarted(health?.startedAt)}</PanelCaption>
      {data.statsError ? (
        <p className="text-muted-foreground">Statistics unavailable.</p>
      ) : (
        <Cells>
          <Cell label="Parsed lines">{count(stats?.totalParsedLines)}</Cell>
          <Cell label="Processed">{count(stats?.totalProcessed)}</Cell>
          <Cell label="Skipped">{count(stats?.totalSkippedLines)}</Cell>
          <Cell label="Ignored">{count(stats?.totalIgnoredLines)}</Cell>
          <Cell label="Pending">{count(stats?.totalPendingRecords)}</Cell>
          <Cell label="Last event">
            <Ticking render={(nowMs) => lastEventState(lastRecordAt, running, nowMs).label} />
          </Cell>
          {failedBatches > 0 && <Cell label="Failed batches">{count(failedBatches)}</Cell>}
          {failedRecords > 0 && <Cell label="Dropped records">{count(failedRecords)}</Cell>}
        </Cells>
      )}
      {health && lastEventState(lastRecordAt, running, Date.now()).detail && (
        <p className="mt-3 text-xs text-muted-foreground">
          {lastEventState(lastRecordAt, running, Date.now()).detail}
        </p>
      )}
      {/* A disabled parser tails nothing by design. */}
      {!disabled && (
        <>
          <PanelSeparator />
          <PanelCaption>Access log sources</PanelCaption>
          {data.filesError && <p className="text-muted-foreground">File list unavailable.</p>}
          {!data.filesError && stats !== undefined && total === 0 && (
            <p className="text-muted-foreground">No access logs configured.</p>
          )}
          {data.accessFiles.length > 0 && (
            <PanelTable
              columns={[
                ["File", 2],
                ["State", 1],
                ["Size", 1],
                ["Last written", 2],
              ]}
            >
              {data.accessFiles.map((file) => (
                <TableRow key={file.name} className={ROW}>
                  <TableCell className={cn(CELL, "font-mono text-[12.5px]")}>{file.name}</TableCell>
                  <TableCell className={CELL}>
                    {file.available ? (
                      <ToneLabel tone="emerald">Available</ToneLabel>
                    ) : (
                      <ToneLabel tone="amber">
                        {capitalize(accessLogUnavailableLabel(file, health))}
                      </ToneLabel>
                    )}
                  </TableCell>
                  <TableCell className={CELL}>
                    {file.available ? formatSize(file.sizeBytes) : dash}
                  </TableCell>
                  <TableCell className={CELL}>
                    {file.available && file.modifiedAt
                      ? clockOrDate(file.modifiedAt, Date.now())
                      : dash}
                  </TableCell>
                </TableRow>
              ))}
            </PanelTable>
          )}
          {lokiSources.length > 0 && (
            <PanelTable
              className={data.accessFiles.length > 0 ? "mt-3" : undefined}
              columns={[
                ["Loki query", 2],
                ["State", 1],
                ["Lines", 1],
                ["Format", 2],
              ]}
            >
              {lokiSources.map((source) => (
                <TableRow key={source.label} className={ROW}>
                  <TableCell className={CELL} title={source.query}>
                    <span className="font-mono text-[12.5px]">{source.query}</span>{" "}
                    <span className="text-muted-foreground">{source.server}</span>
                  </TableCell>
                  <TableCell className={CELL}>
                    {source.available ? (
                      <ToneLabel tone="emerald">Available</ToneLabel>
                    ) : (
                      <ToneLabel tone="amber">
                        {source.reason === "rejected" ? "Rejected" : "Unreachable"}
                      </ToneLabel>
                    )}
                  </TableCell>
                  <TableCell className={CELL}>{source.parsedLines.toLocaleString()}</TableCell>
                  <TableCell className={CELL}>{source.logFormat ?? "format pending"}</TableCell>
                </TableRow>
              ))}
            </PanelTable>
          )}
        </>
      )}
    </BoardPanel>
  )
  return { id: "ingestion", icon: Activity, name: "Ingestion", state, fact, counts: true, panel }
}

function databaseRow({ health, dbInfo }: StatusData): BoardRowSpec {
  const state = databaseState(health)
  const reachable = dbInfo?.reachable === true
  const postgres = dbInfo?.postgresVersion?.split(" ")[0]
  const fact = !health
    ? null
    : !health.database.reachable
      ? "Running without a database"
      : health.database.servicesActive === false
        ? "Background jobs and ingestion are paused"
        : reachable
          ? [
              dbInfo.sizeBytes !== null ? formatSize(dbInfo.sizeBytes) : null,
              postgres && `PostgreSQL ${postgres}`,
              dbInfo.timescaledbVersion && `TimescaleDB ${dbInfo.timescaledbVersion}`,
            ]
              .filter(Boolean)
              .join(" · ")
          : null
  const compression = compressionSummary(dbInfo?.hypertables)
  const panel = (
    <BoardPanel sentence={state.detail}>
      {reachable ? (
        <>
          <Cells>
            <Cell label="Size">
              {dbInfo.sizeBytes !== null ? formatSize(dbInfo.sizeBytes) : "-"}
            </Cell>
            <Cell label="PostgreSQL">{postgres ?? "-"}</Cell>
            <Cell label="TimescaleDB">{dbInfo.timescaledbVersion ?? "-"}</Cell>
            <Cell label="Raw events kept">{dbInfo.retentionDays} days</Cell>
            <Cell label="Debug lines kept">{dbInfo.debugRetentionDays} days</Cell>
            <Cell label="Compression">{compression ? compression.split(" ")[0] : "-"}</Cell>
          </Cells>
          <PanelSeparator />
          <PanelCaption>Hypertables</PanelCaption>
          <PanelTable
            columns={[
              ["Hypertable", 2],
              ["Rows", 1],
              ["Size", 1],
              ["Compression", 2],
            ]}
          >
            {dbInfo.hypertables.map((table) => (
              <TableRow key={table.name} className={ROW}>
                <TableCell className={cn(CELL, "font-mono text-[12.5px]")}>{table.name}</TableCell>
                <TableCell className={CELL}>~{formatApproxRows(table.approxRows)}</TableCell>
                <TableCell className={CELL}>
                  {table.totalBytes !== null ? formatSize(table.totalBytes) : dash}
                </TableCell>
                <TableCell className={CELL}>{compressionRatio(table)}</TableCell>
              </TableRow>
            ))}
          </PanelTable>
        </>
      ) : (
        !state.detail && <p className="text-muted-foreground">Database details unavailable.</p>
      )}
    </BoardPanel>
  )
  return { id: "database", icon: Database, name: "Database", state, fact, counts: true, panel }
}

function geoipRow({ health, jobs }: StatusData, now: number): BoardRowSpec {
  const state = geoipState(health)
  const geoip = health?.geoip
  const refresh = jobs?.find((job) => job.id === "geoip-refresh")?.nextRunTime
  const fact = !geoip?.available
    ? geoip
      ? "Requests cannot be geolocated"
      : null
    : [
        geoip.dbBuildDate && `City database ${ageLabel(geoip.dbBuildDate, now)}`,
        geoip.asnAvailable && geoip.asnDbBuildDate && `ASN ${ageLabel(geoip.asnDbBuildDate, now)}`,
      ]
        .filter(Boolean)
        .join(" · ")
  const end = refresh && (
    <Ticking render={(nowMs) => `next refresh ${untilLabel(refresh, nowMs)}`} />
  )
  const panel = (
    <BoardPanel sentence={state.detail}>
      <Cells action={<PanelLink to="/settings/scheduler">Open Scheduler</PanelLink>}>
        <Cell label="City database">
          {geoipDatabase(geoip?.available, geoip?.dbBuildDate, now)}
        </Cell>
        <Cell label="ASN database">
          {geoipDatabase(geoip && (geoip.asnAvailable ?? false), geoip?.asnDbBuildDate, now)}
        </Cell>
        <Cell label="Next refresh">
          {refresh ? <Ticking render={(nowMs) => untilLabel(refresh, nowMs)} /> : "-"}
        </Cell>
      </Cells>
    </BoardPanel>
  )
  return { id: "geoip", icon: Globe, name: "GeoIP", state, fact, end, counts: true, panel }
}

function crowdsecRow({ crowdsec, crowdsecError, crowdsecStats }: StatusData): BoardRowSpec {
  const state = crowdsecState(crowdsec, crowdsecError)
  const decisions = crowdsecStats && `${crowdsecStats.total.toLocaleString()} active decisions`
  let fact: React.ReactNode = null
  if (crowdsecError) fact = "The CrowdSec status could not be read"
  else if (crowdsec?.enabled && !crowdsec.lapiReachable) fact = "Bans cannot be viewed or changed"
  else if (crowdsec && !crowdsec.enabled) fact = "The CrowdSec integration is off"
  else if (crowdsec) {
    fact = [crowdsec.writeEnabled ? "Write enabled" : "Read only", decisions]
      .filter(Boolean)
      .join(" · ")
  }
  const unreachable = crowdsec?.enabled === true && !crowdsec.lapiReachable
  const panel = (
    <BoardPanel sentence={state.detail}>
      {crowdsecError && crowdsec && (
        <p className="mb-3 text-muted-foreground">
          The CrowdSec status could not be read. These values are from the last read.
        </p>
      )}
      {crowdsec?.enabled ? (
        <Cells
          action={
            unreachable ? (
              <PanelLink to="/settings/logs">Open Logs</PanelLink>
            ) : (
              <PanelLink to="/security">Open Security</PanelLink>
            )
          }
        >
          <Cell label="Write access">{crowdsec.writeEnabled ? "Enabled" : "Read only"}</Cell>
          <Cell label="Live updates">{crowdsec.liveUpdates === false ? "Paused" : "On"}</Cell>
          {crowdsecStats && (
            <Cell label="Active decisions">{crowdsecStats.total.toLocaleString()}</Cell>
          )}
        </Cells>
      ) : (
        <p className="text-muted-foreground">
          {crowdsec
            ? "The CrowdSec integration is off."
            : crowdsecError
              ? "The CrowdSec status could not be read."
              : "-"}
        </p>
      )}
    </BoardPanel>
  )
  return { id: "crowdsec", icon: ShieldCheck, name: "CrowdSec", state, fact, counts: true, panel }
}

function schedulerRow({ jobs, jobsError }: StatusData, now: number): BoardRowSpec {
  const summary = schedulerSummary(jobs, jobsError, now)
  const state: CardState = { tone: summary.tone, label: summary.label }
  const failed = jobs?.filter((job) => !job.running && job.lastStatus === "error") ?? []
  const next = nextSchedulerJob(jobs)
  const nextAt = next?.nextRunTime
  let fact: React.ReactNode = null
  if (failed.length > 0) fact = `Last run failed: ${failed.map((job) => job.name).join(", ")}`
  else if (next) fact = `Next: ${next.name}`
  const end = nextAt && failed.length === 0 && (
    <Ticking render={(nowMs) => untilLabel(nextAt, nowMs)} />
  )
  const panel = (
    <BoardPanel>
      {jobsError && <p className="text-muted-foreground">Job list unavailable.</p>}
      {jobs && (
        <PanelTable
          columns={[
            ["Job", 3],
            ["State", 1],
            ["Last run", 1],
            ["Next run", 1],
          ]}
        >
          {jobs.map((job) => {
            const jobState = schedulerJobState(job)
            const nextRun = job.nextRunTime
            const lastRun = job.lastRunTime
            return (
              <TableRow key={job.id} className={ROW}>
                <TableCell className={cn(CELL, "font-medium")} title={job.name}>
                  {job.name}
                </TableCell>
                <TableCell className={CELL} title={jobState.detail}>
                  <ToneLabel tone={jobState.tone}>{jobState.label}</ToneLabel>
                </TableCell>
                <TableCell className={CELL}>
                  {lastRun ? <Ticking render={(nowMs) => relativeTime(lastRun, nowMs)} /> : dash}
                </TableCell>
                <TableCell className={CELL}>
                  {job.running ? (
                    "running now"
                  ) : nextRun ? (
                    <Ticking render={(nowMs) => untilLabel(nextRun, nowMs)} />
                  ) : (
                    dash
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </PanelTable>
      )}
      <PanelFooter>
        <PanelLink to="/settings/scheduler">Open Scheduler</PanelLink>
      </PanelFooter>
    </BoardPanel>
  )
  return {
    id: "scheduler",
    icon: CalendarClock,
    name: "Scheduler",
    state,
    fact,
    end,
    counts: true,
    panel,
  }
}

const LIVE_FEED_FACTS: Record<LiveFeedStatus, string> = {
  connected: "WebSocket stream for the map and live views",
  connecting: "WebSocket stream for the map and live views",
  unavailable: "The server pauses it until the database or ingestion is back",
  disconnected: "Check WebSocket support on your reverse proxy",
}

function liveFeedRow({ feedStatus }: StatusData, settled: boolean): BoardRowSpec {
  const live = liveFeedState(feedStatus)
  // Muted for the first seconds of a drop, so the row neither looks like a
  // problem nor counts as one until the grace period is over.
  const state: CardState =
    feedStatus === "connected" || settled ? live : { tone: "muted", label: live.label }
  const panel = (
    <BoardPanel sentence={state.detail}>
      <PanelCaption>
        The WebSocket stream behind the map and the live views, probed while this page is open.
      </PanelCaption>
      <Cells>
        <Cell label="Connection">{state.label}</Cell>
      </Cells>
    </BoardPanel>
  )
  return {
    id: "live-feed",
    icon: Radio,
    name: "Live feed",
    state,
    fact: LIVE_FEED_FACTS[feedStatus],
    counts: true,
    panel,
  }
}

function authRow({ me, meError, oidc, oidcError }: StatusData): BoardRowSpec {
  const auth = authState(me, meError)
  // A failed status poll keeps the cached answer, so a failing discovery does
  // not read as a recovery for one poll.
  const oidcLine = oidcState(oidc, oidcError && !oidc)
  // A failed discovery is the worse news, so it takes the row.
  const state = oidcLine?.tone === "red" ? oidcLine : auth
  let fact: React.ReactNode = null
  if (me?.mode === "session") {
    fact = `Signed in as ${me.username}${me.provider === "oidc" && oidc?.providerName ? ` with ${oidc.providerName}` : ""}`
  } else if (me) fact = "Anyone who can reach this app has full access"
  const stale =
    oidcError && oidc
      ? "The identity provider status could not be read. These values are from the last read."
      : undefined
  const sentence = [auth.detail, oidcLine?.detail, stale].filter(Boolean).join(" ") || undefined
  const panel = (
    <BoardPanel sentence={sentence}>
      <Cells>
        <Cell label="Login">
          {me?.mode === "session" ? (me.provider === "oidc" ? "SSO" : "Password") : auth.label}
        </Cell>
        {me?.mode === "session" && <Cell label="User">{me.username}</Cell>}
        {oidc?.configured && <Cell label="Provider">{oidc.providerName ?? "-"}</Cell>}
        {oidcLine && (
          <Cell label="Identity provider">
            <ToneLabel tone={oidcLine.tone}>{oidcLine.label}</ToneLabel>
          </Cell>
        )}
        {oidc?.configured && (
          <Cell label="Password login">{oidc.passwordLogin ? "On" : "Off"}</Cell>
        )}
        {oidc?.configured && <Cell label="IdP logout">{oidc.idpLogout ? "On" : "Off"}</Cell>}
      </Cells>
      {oidc?.configured && oidc.issuer && (
        <p className="mt-3 text-xs text-muted-foreground">
          Issuer <MonoChip>{oidc.issuer}</MonoChip>
        </p>
      )}
    </BoardPanel>
  )
  return {
    id: "auth",
    icon: ShieldUser,
    name: "Authentication",
    state,
    fact,
    counts: true,
    panel,
  }
}

function agentsRow({ instancesError }: StatusData, overview: AgentSummary): BoardRowSpec {
  const [count, ...rest] = overview.line.split(", ")
  const state: CardState = instancesError
    ? { tone: "muted", label: "Unavailable" }
    : { tone: overview.tone, label: count }
  const panel = (
    <BoardPanel>
      <Cells action={<PanelLink to="/settings/agents">Open Agents</PanelLink>}>
        <Cell label="Agents">{count}</Cell>
        <Cell label="State" title={instancesError ? undefined : rest.join(", ")}>
          {instancesError ? "List unavailable" : capitalize(rest.join(", ") || "healthy")}
        </Cell>
      </Cells>
    </BoardPanel>
  )
  return {
    id: "agents",
    icon: Network,
    name: "Agents",
    state,
    fact: instancesError ? "The agent list could not be read" : capitalize(rest.join(", ")),
    counts: false,
    panel,
  }
}

function locationsRow(rows: ServerLocationRow[]): BoardRowSpec {
  const panel = (
    <BoardPanel>
      <PanelCaption>Where each server sits on the map and where its live routes land.</PanelCaption>
      <PanelTable
        columns={[
          ["Server", 2],
          ["Location", 1],
          ["Source", 1],
          ["Last traffic", 1],
          ["", 1],
        ]}
      >
        {rows.map((row) => (
          <LocationTableRow key={row.server} row={row} />
        ))}
      </PanelTable>
    </BoardPanel>
  )
  return {
    id: "locations",
    icon: MapPin,
    name: "Server locations",
    state: { tone: "emerald", label: `${rows.length} placed` },
    fact: locationsFact(rows),
    end: locationsSource(rows),
    counts: true,
    panel,
  }
}

function LocationTableRow({ row }: { row: ServerLocationRow }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteServerLocation()
  return (
    <TableRow className={ROW}>
      <TableCell className={cn(CELL, "font-mono text-[12.5px]")}>{row.server}</TableCell>
      <TableCell className={CELL}>{row.coords}</TableCell>
      <TableCell className={CELL}>
        {row.source === "override" ? (
          <span title="Pinned by MAP_SERVER_LOCATIONS; edit it there.">override</span>
        ) : (
          "auto"
        )}
      </TableCell>
      <TableCell className={cn(CELL, row.stale && "text-amber-600 dark:text-amber-500")}>
        {row.lastSeen.replace(/^Traffic /, "")}
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        {row.source === "auto" && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove location for ${row.server}`}
              className="text-muted-foreground hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => setConfirming(true)}
            >
              <Trash2 />
            </Button>
            <RemoveLocationAlert
              server={row.server}
              open={confirming}
              onOpenChange={setConfirming}
              pending={remove.isPending}
              onRemove={() => remove.mutate(row.server, { onSettled: () => setConfirming(false) })}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  )
}

function recentErrorsRow({ recentErrors, logsError }: StatusData): BoardRowSpec {
  const state: CardState = logsError
    ? { tone: "muted", label: "Unavailable" }
    : recentErrors.length > 0
      ? { tone: "amber", label: `${recentErrors.length} recent` }
      : { tone: "emerald", label: "None" }
  const fact = logsError
    ? "The application log could not be read"
    : recentErrors.length > 0
      ? recentErrors[0].event
      : "No error-level events in the application log"
  const panel = (
    <BoardPanel>
      {logsError && recentErrors.length > 0 && (
        <p className="mb-3 text-muted-foreground">
          The log tail could not be read. These are the errors from the last read.
        </p>
      )}
      {recentErrors.length > 0 ? (
        <PanelTable
          columns={[
            ["Time", 1],
            ["Logger", 1],
            ["Event", 4],
          ]}
        >
          {recentErrors.map((record, index) => (
            <TableRow key={index} className={ROW}>
              <TableCell className={CELL}>
                {record.timestamp ? clockOrDate(record.timestamp, Date.now()) : dash}
              </TableCell>
              <TableCell className={cn(CELL, "font-mono text-[12.5px]")} title={record.logger}>
                {record.logger ?? dash}
              </TableCell>
              <TableCell className={CELL} title={record.event}>
                {record.event}
              </TableCell>
            </TableRow>
          ))}
        </PanelTable>
      ) : (
        <p className="text-muted-foreground">
          {logsError
            ? "The log tail could not be read."
            : "No error-level events in the application log."}
        </p>
      )}
      <PanelFooter>
        <PanelLink to="/settings/logs">Open Logs</PanelLink>
      </PanelFooter>
    </BoardPanel>
  )
  return {
    id: "recent-errors",
    icon: TriangleAlert,
    name: "Recent errors",
    state,
    fact,
    counts: false,
    autoOpen: false,
    panel,
  }
}

// border-t! beats TableBody's rule that clears the last row's borders.
const ROW = "border-t! border-b-0 border-border/70 hover:bg-transparent"
const CELL = "h-9 truncate py-0 pr-4 pl-0 tabular-nums"

/** A table on the panel's six-column grid; each column spans some of the six. */
function PanelTable({
  columns,
  className,
  children,
}: {
  columns: readonly (readonly [label: string, span: number])[]
  className?: string
  children: React.ReactNode
}) {
  return (
    // On a narrow board the table scrolls sideways instead of squeezing its columns.
    <Table className="min-w-[520px] table-fixed" containerClassName={className}>
      <colgroup>
        {columns.map(([label, span], index) => (
          <col key={`${label}-${index}`} style={{ width: `${(span / 6) * 100}%` }} />
        ))}
      </colgroup>
      <TableHeader className="[&_tr]:border-b-0">
        <TableRow className="hover:bg-transparent">
          {columns.map(([label, _span], index) => (
            <TableHead key={`${label}-${index}`} className="h-[26px] pr-4 pl-0 align-top">
              {label || <span className="sr-only">Actions</span>}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  )
}

/** "built 21d ago", "Loaded" without a build date, "Not loaded", or "-"
 *  while /health has not answered. */
function geoipDatabase(
  available: boolean | null | undefined,
  buildDate: string | null | undefined,
  now: number,
): string {
  if (available === undefined) return "-"
  if (!available) return "Not loaded"
  return buildDate ? `built ${relativeTime(buildDate, now)}` : "Loaded"
}

function count(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString()
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}
