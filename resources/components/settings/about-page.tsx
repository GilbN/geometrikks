import { useEffect, useState, type ReactNode } from "react"
import { Bug, Cpu, Database, ExternalLink, Globe2 } from "lucide-react"
import type { AboutResponse } from "@/generated/api/types.gen"
import { useAbout, useReleaseCheck } from "@/lib/queries"
import { releaseCheckLine, skippedReleasesText } from "@/lib/release-check"
import { saveSeenRelease } from "@/lib/release-seen"
import { displayVersion, hasUncommittedChanges, publicVersion } from "@/lib/version"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import { BrandMark } from "@/components/brand/brand-mark"
import { Wordmark } from "@/components/brand/wordmark"
import { AsnListDialog } from "@/components/settings/asn-list-dialog"

function formatUptime(startedAt: string | null | undefined): string {
  if (!startedAt) return "unknown"
  let seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** GeoLite2 EULA expects refresh within 30 days; warn as that approaches. */
function geoipFreshness(available: boolean, ageDays: number | null | undefined): {
  tone: LedTone
  label: string
} {
  if (!available) return { tone: "red", label: "not available" }
  if (ageDays === null || ageDays === undefined) return { tone: "emerald", label: "available" }
  if (ageDays > 30) return { tone: "red", label: `stale (${ageDays} days old)` }
  if (ageDays > 14) return { tone: "amber", label: `aging (${ageDays} days old)` }
  return { tone: "emerald", label: `fresh (${ageDays} days old)` }
}

/** Which alembic revision the database is on, against the one this build ships. */
function MigrationState({ database }: { database: AboutResponse["database"] }) {
  const { migrationRevision, migrationName, migrationHead } = database
  if (!migrationRevision) return <span className="text-muted-foreground">unavailable</span>
  const atHead = migrationRevision === migrationHead
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {migrationName && <span className="text-muted-foreground">{migrationName}</span>}
      <MonoChip>{migrationRevision}</MonoChip>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusLed tone={atHead ? "emerald" : "amber"} />
        {atHead ? "at head" : `build ships ${migrationHead}`}
      </span>
    </span>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/40 py-1.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="break-all text-right text-sm">{value ?? "unknown"}</span>
    </div>
  )
}

function SectionIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
      <Icon className="h-4 w-4 text-primary" />
    </div>
  )
}

const RELEASE_LINE_TICK_MS = 60_000

/** Marks the release seen only once its announcement is on screen. */
function useReleaseLine() {
  const { data: releaseCheck } = useReleaseCheck()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const releaseLine = releaseCheckLine(releaseCheck, nowMs)
  const announcedVersion = releaseLine?.kind === "available" ? releaseCheck?.latest?.version : undefined

  useEffect(() => {
    if (announcedVersion) saveSeenRelease(announcedVersion)
  }, [announcedVersion])

  const lineShown = releaseLine !== null
  useEffect(() => {
    if (!lineShown) return
    const interval = setInterval(() => setNowMs(Date.now()), RELEASE_LINE_TICK_MS)
    return () => clearInterval(interval)
  }, [lineShown])

  return { releaseLine, latest: releaseCheck?.latest ?? null }
}

/** Grows a small link's hit area to thumb size without moving the layout. */
const TAP_AREA = "relative after:absolute after:-inset-y-2 after:-inset-x-1 after:content-['']"

const TRACK_STEP =
  "relative flex gap-3.5 pb-5 last:pb-0 @2xl:min-w-0 @2xl:flex-1 @2xl:pb-0 @2xl:pr-10 @2xl:group-data-[steps]/track:flex-col @2xl:group-data-[steps]/track:gap-2.5"

/** Dashed line from a step's node to the next step's. */
function TrackConnector() {
  return (
    <span
      aria-hidden
      className="absolute top-4 bottom-1 left-[5px] border-l border-dashed border-muted-foreground/40 @2xl:top-[10px] @2xl:right-2 @2xl:bottom-auto @2xl:left-5 @2xl:border-t @2xl:border-l-0"
    />
  )
}

/** One stop on the version track: the running build or the newer release. */
function TrackStop({
  stop,
  label,
  version,
  versionTitle,
  children,
  connector = false,
}: {
  stop: "running" | "available"
  label: string
  version: string
  versionTitle?: string
  children?: ReactNode
  connector?: boolean
}) {
  return (
    <li className={cn(TRACK_STEP, "@2xl:max-w-64")}>
      {connector && <TrackConnector />}
      <span
        aria-hidden
        className={cn(
          "relative mt-[5px] size-[11px] shrink-0 rounded-full",
          stop === "running"
            ? "bg-foreground"
            : "border-[1.5px] border-primary bg-card shadow-[0_0_8px_color-mix(in_oklab,var(--primary)_40%,transparent)]",
        )}
      />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          title={versionTitle}
          className={cn(
            "mt-0.5 font-mono leading-tight tracking-tight break-all",
            stop === "running"
              ? "text-[22px] font-semibold"
              : "text-[17px] font-medium text-muted-foreground",
          )}
        >
          {version}
        </p>
        {children}
      </div>
    </li>
  )
}

/** The releases between the running build and the newest, as one small step. */
function SkippedReleases({ text, href }: { text: string; href: string }) {
  // Keeps the link icon on the same line as the last word when the text wraps.
  const lastSpace = text.lastIndexOf(" ")
  return (
    <li className={cn(TRACK_STEP, "@2xl:max-w-64")}>
      <TrackConnector />
      <span aria-hidden className="relative mt-[5px] flex size-[11px] shrink-0 items-center justify-center">
        <span className="size-[5px] rounded-full bg-muted-foreground/70" />
      </span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "self-start pt-[3px] text-xs text-muted-foreground hover:text-foreground @2xl:pt-0",
          TAP_AREA,
        )}
      >
        {text.slice(0, lastSpace + 1)}
        <span className="whitespace-nowrap">
          {text.slice(lastSpace + 1)}
          <ExternalLink className="ml-1.5 inline h-3 w-3 align-[-1px]" />
        </span>
      </a>
    </li>
  )
}

/** The running version, its uptime, and the newer release when there is one. */
function InstallationCard({ app, repository }: { app: AboutResponse["app"]; repository: string }) {
  const { releaseLine, latest } = useReleaseLine()
  // The +local suffix repeats the commit linked below, so the headline drops
  // it and keeps the full string on hover.
  const fullVersion = displayVersion(app.version)
  const version = displayVersion(publicVersion(app.version))
  const newer = releaseLine?.kind === "available" && latest ? { ...releaseLine, latest } : null
  const skippedText = newer ? skippedReleasesText(newer.latest.newerReleaseCount, newer.latest.newerReleaseCountExact) : null
  // The release workflow tags images with the version, so a tag that matches
  // it says nothing new; a hand-built image tagged "latest" or "local" does.
  const runtimeLabel = app.container
    ? app.imageTag && app.imageTag !== version
      ? `container: ${app.imageTag}`
      : "container"
    : "host"

  return (
    <Card className="@container md:col-span-2">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-5">
        <div className="order-1 flex grow items-center gap-2.5">
          <BrandMark size={28} className="text-foreground @2xl:size-8" decorative />
          <Wordmark className="text-[14px] text-foreground @2xl:text-[16px]" />
        </div>
        <div className="order-2 flex items-center gap-2 text-sm @2xl:order-3">
          <StatusLed tone="emerald" pulse />
          <span className="text-muted-foreground">up</span>
          <span className="font-medium tabular-nums">{formatUptime(app.startedAt)}</span>
        </div>
        <ol
          className="group/track order-3 mt-3 flex basis-full flex-col @2xl:order-4 @2xl:flex-row"
          data-steps={newer ? "" : undefined}
        >
          <TrackStop
            stop="running"
            label="Running"
            version={version}
            versionTitle={fullVersion !== version ? fullVersion : undefined}
            connector={newer !== null}
          >
            {app.commit && (
              <a
                href={`${repository}/commit/${app.commit}`}
                target="_blank"
                rel="noreferrer"
                title={app.commit}
                className={cn(
                  "mt-1 inline-flex items-baseline gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground",
                  TAP_AREA,
                )}
              >
                commit <span className="font-mono text-xs">{app.commit.slice(0, 7)}</span>
                <ExternalLink className="h-3 w-3 self-center" />
              </a>
            )}
            {hasUncommittedChanges(app.version) && (
              <p className="mt-1 text-xs text-muted-foreground">Built with uncommitted changes</p>
            )}
            {releaseLine?.kind === "up-to-date" && (
              <p className="mt-2 text-xs text-muted-foreground">{releaseLine.text}</p>
            )}
          </TrackStop>
          {skippedText && <SkippedReleases text={skippedText} href={`${repository}/releases`} />}
          {newer && (
            <TrackStop stop="available" label="Available" version={newer.latest.displayVersion}>
              <a
                href={newer.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "mt-1 inline-flex items-center gap-1.5 text-[12.5px] underline decoration-muted-foreground/50 underline-offset-[3px] hover:decoration-foreground",
                  TAP_AREA,
                )}
              >
                Release notes
                <ExternalLink className="h-3 w-3" />
              </a>
            </TrackStop>
          )}
        </ol>
        <div className="order-4 mt-3 flex basis-full flex-wrap gap-1.5 border-t border-border/60 pt-4 @2xl:order-2 @2xl:mt-0 @2xl:mr-2 @2xl:basis-auto @2xl:border-0 @2xl:pt-0">
          <Badge variant="outline" className="text-muted-foreground">
            {app.environment}
          </Badge>
          <Badge variant="outline" className="text-muted-foreground">
            {runtimeLabel}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}

export function AboutPage() {
  const { data, isLoading } = useAbout()
  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-24 w-full md:col-span-2" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  const geoip = geoipFreshness(data.geoip.available, data.geoip.ageDays)
  const asn =
    data.geoipAsnEnabled && data.geoipAsn
      ? geoipFreshness(data.geoipAsn.available, data.geoipAsn.ageDays)
      : null
  const dbReachable = data.database.postgresVersion !== null

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <InstallationCard app={data.app} repository={data.links.repository} />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <SectionIcon icon={Cpu} />
            <CardTitle className="text-base">Runtime</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Row label="Python" value={<MonoChip>{data.runtime.pythonVersion}</MonoChip>} />
          <Row
            label="Litestar"
            value={
              data.runtime.litestarVersion ? (
                <MonoChip>{data.runtime.litestarVersion}</MonoChip>
              ) : (
                "unknown"
              )
            }
          />
          <Row
            label="APScheduler"
            value={
              data.runtime.apschedulerVersion ? (
                <MonoChip>{data.runtime.apschedulerVersion}</MonoChip>
              ) : (
                "unknown"
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Database} />
              <CardTitle className="text-base">Database</CardTitle>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusLed tone={dbReachable ? "emerald" : "red"} />
              {dbReachable ? "connected" : "unreachable"}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <Row
            label="PostgreSQL"
            value={
              data.database.postgresVersion ? (
                <MonoChip>{data.database.postgresVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
          <Row
            label="TimescaleDB"
            value={
              data.database.timescaledbVersion ? (
                <MonoChip>{data.database.timescaledbVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
          <Row
            label="PostGIS"
            value={
              data.database.postgisVersion ? (
                <MonoChip>{data.database.postgisVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
          <Row label="Migration" value={<MigrationState database={data.database} />} />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-3">
            <SectionIcon icon={Globe2} />
            <CardTitle className="text-base">GeoIP databases</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-3 border-b border-border/40 pb-1.5">
                <span className="text-sm font-medium">City</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusLed tone={geoip.tone} />
                  {geoip.label}
                </span>
              </div>
              <Row
                label="Build date"
                value={
                  data.geoip.buildDate
                    ? new Date(data.geoip.buildDate).toLocaleDateString()
                    : "unknown"
                }
              />
              <Row
                label="Age"
                value={
                  data.geoip.ageDays !== null && data.geoip.ageDays !== undefined
                    ? `${data.geoip.ageDays} days`
                    : "unknown"
                }
              />
              <Row label="Path" value={<MonoChip>{data.geoip.dbPath}</MonoChip>} />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3 border-b border-border/40 pb-1.5">
                <span className="text-sm font-medium">ASN</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {asn ? (
                    <>
                      <StatusLed tone={asn.tone} />
                      {asn.label}
                    </>
                  ) : (
                    "disabled"
                  )}
                </span>
              </div>
              {asn && data.geoipAsn ? (
                <>
                  <Row
                    label="Build date"
                    value={
                      data.geoipAsn.buildDate
                        ? new Date(data.geoipAsn.buildDate).toLocaleDateString()
                        : "unknown"
                    }
                  />
                  <Row
                    label="Age"
                    value={
                      data.geoipAsn.ageDays !== null && data.geoipAsn.ageDays !== undefined
                        ? `${data.geoipAsn.ageDays} days`
                        : "unknown"
                    }
                  />
                  <Row label="Path" value={<MonoChip>{data.geoipAsn.dbPath}</MonoChip>} />
                  {data.asnClassification && (
                    <>
                      <Row
                        label="Classification list"
                        value={
                          <a
                            href={data.asnClassification.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 hover:underline underline-offset-2"
                          >
                            <MonoChip>
                              {data.asnClassification.dataset} · {data.asnClassification.entries} ASNs · {data.asnClassification.license}
                            </MonoChip>
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                          </a>
                        }
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                        <p className="max-w-[32ch] text-xs text-muted-foreground">
                          Community list of hosting, VPN, and datacenter
                          operators; matching networks are badged Hosting,
                          the rest show as Other.
                        </p>
                        <AsnListDialog />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="pt-1.5 text-sm text-muted-foreground">
                  ASN enrichment is turned off (GEOIP_ASN_ENABLED=false).
                </p>
              )}
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            This product includes GeoLite2 data created by MaxMind, available
            from{" "}
            <a
              href="https://www.maxmind.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              maxmind.com
            </a>
            .
          </p>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardContent className="flex flex-wrap gap-2 py-4">
          <Button variant="outline" size="sm" className="pointer-coarse:h-10" asChild>
            <a href={data.links.repository} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              GitHub repository
            </a>
          </Button>
          <Button variant="outline" size="sm" className="pointer-coarse:h-10" asChild>
            <a href={data.links.issues} target="_blank" rel="noopener noreferrer">
              <Bug className="mr-1.5 h-3.5 w-3.5" />
              Issue tracker
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
