import { Link } from "@tanstack/react-router"
import { Activity, CalendarClock, Database, Globe, Radio, ShieldCheck, TriangleAlert } from "lucide-react"
import {
  useCrowdsecStats,
  useCrowdsecStatus,
  useDatabaseInfo,
  useHealth,
  useLogFiles,
  useRecentErrors,
  useSchedulerJobs,
  useStats,
} from "@/lib/queries"
import { useLiveEvents, useLiveFeedStatus } from "@/lib/live-feed-context"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import {
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
  nginxLogFiles,
  overallState,
  relativeTime,
  schedulerJobState,
} from "@/components/settings/status-logic"

function SectionIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
      <Icon className="h-4 w-4 text-geo-cyan" />
    </div>
  )
}

function StateLine({ state }: { state: CardState }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <StatusLed tone={state.tone} pulse={state.tone === "emerald"} />
        <span className="text-sm font-medium">{state.label}</span>
      </div>
      {state.detail && <p className="text-xs text-muted-foreground">{state.detail}</p>}
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
export function StatusOverview() {
  const { data: health, isError: healthError, isLoading: healthLoading } = useHealth()
  const { data: stats, isError: statsError } = useStats()
  const { data: crowdsec, isError: crowdsecError } = useCrowdsecStatus()
  const { data: crowdsecStats } = useCrowdsecStats()
  const { data: files, isError: filesError } = useLogFiles()
  const { data: schedulerData, isError: jobsError } = useSchedulerJobs()
  const jobs = schedulerData?.jobs
  const { data: dbInfo } = useDatabaseInfo()
  const { data: logRecords, isError: logsError } = useRecentErrors()
  const feedStatus = useLiveFeedStatus()
  // Probe the live WebSocket while this page is open: the client is
  // per-tab and lazy, so without our own subscription the card could
  // never read anything but disconnected. Last unsubscriber closes it.
  useLiveEvents(() => {}, true)

  const now = Date.now()
  const overall = overallState(health, healthError)
  const nginx = nginxLogFiles(files)
  const uptime = formatUptime(health?.started_at, now)
  const geoipRefreshJob = jobs?.find((j) => j.id === "geoip-refresh")
  const recentErrors = filterErrorRecords(logRecords, 5)

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

  return (
    <div className="space-y-4">
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Activity} />
              <div>
                <CardTitle className="text-base">Ingestion</CardTitle>
                <CardDescription>Nginx log tailing and parsing pipeline</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <StateLine state={ingestionState(health, healthError)} />
            {statsError ? (
              <p className="text-xs text-muted-foreground">Statistics unavailable.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <Counter label="Parsed lines" value={stats?.total_parsed_lines} />
                <Counter label="Processed" value={stats?.total_processed} />
                <Counter label="Skipped lines" value={stats?.total_skipped_lines} />
                <Counter label="Ignored lines" value={stats?.total_ignored_lines} />
                <Counter label="Pending records" value={stats?.total_pending_records} />
              </div>
            )}
            {health && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Last event</span>
                {(() => {
                  const state = lastEventState(
                    health.ingestion.last_record_at,
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
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Tailed access logs</p>
              {filesError && <p className="text-xs text-muted-foreground">File list unavailable.</p>}
              {!filesError && nginx.length === 0 && (
                <p className="text-xs text-muted-foreground">No nginx access logs configured.</p>
              )}
              {nginx.map((f) => (
                <div key={f.name} className="flex items-center gap-2 text-xs">
                  <StatusLed tone={f.available ? "emerald" : "red"} />
                  <MonoChip>{f.name}</MonoChip>
                  {f.available ? (
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {formatSize(f.size_bytes)}
                      {f.modified_at && ` · ${new Date(f.modified_at).toLocaleString()}`}
                    </span>
                  ) : (
                    <span className="ml-auto text-red-500">missing</span>
                  )}
                </div>
              ))}
            </div>
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
            <StateLine state={databaseState(health)} />
            {dbInfo?.reachable && (
              <>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    {dbInfo.size_bytes !== null && (
                      <span className="font-medium text-foreground">
                        {formatSize(dbInfo.size_bytes)}
                      </span>
                    )}{" "}
                    total · PostgreSQL {dbInfo.postgres_version?.split(" ")[0]} · TimescaleDB{" "}
                    {dbInfo.timescaledb_version}
                  </p>
                  <p>
                    Raw events kept {dbInfo.retention_days} days, debug lines{" "}
                    {dbInfo.debug_retention_days} days
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
                        ~{formatApproxRows(t.approx_rows)} rows
                        {t.total_bytes !== null && ` · ${formatSize(t.total_bytes)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Globe} />
              <div>
                <CardTitle className="text-base">GeoIP</CardTitle>
                <CardDescription>MaxMind GeoLite2 database</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <StateLine state={geoipState(health)} />
            <div className="space-y-1 text-xs text-muted-foreground">
              {health?.geoip.db_build_date && (
                <p>Database built {relativeTime(health.geoip.db_build_date, now)}</p>
              )}
              {geoipRefreshJob?.next_run_time && (
                <p>Next refresh {relativeTime(geoipRefreshJob.next_run_time, now)}</p>
              )}
            </div>
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
            <StateLine state={crowdsecState(crowdsec, crowdsecError)} />
            <div className="flex items-center gap-2">
              {crowdsec?.enabled && (
                <Badge variant="outline">
                  {crowdsec.write_enabled ? "write enabled" : "read only"}
                </Badge>
              )}
              {crowdsecStats && (
                <Link
                  to="/security"
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {crowdsecStats.total.toLocaleString()} active decisions
                </Link>
              )}
            </div>
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
                  <Link to="/settings/scheduler" className="underline underline-offset-2">
                    details
                  </Link>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
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
                      : job.next_run_time
                        ? `next ${relativeTime(job.next_run_time, now)}`
                        : state.label}
                  </span>
                </div>
              )
            })}
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
            <StateLine state={liveFeedState(feedStatus)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <SectionIcon icon={TriangleAlert} />
            <div>
              <CardTitle className="text-base">Recent errors</CardTitle>
              <CardDescription>
                Latest error-level events from the application log ·{" "}
                <Link to="/settings/logs" className="underline underline-offset-2">
                  open Logs
                </Link>
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
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
        </CardContent>
      </Card>
    </div>
  )
}
