import { useEffect, useRef, useState, type ReactNode } from "react"
import { Loader2, RotateCw, ScanSearch, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import { BadgeHint } from "@/components/badge-hint"
import { CountryFlag } from "@/components/country-flag"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { ExternalLink } from "@/components/crowdsec/external-link"
import { DropBadge } from "@/components/drop/drop-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DecisionView, IpProfileResponse } from "@/generated/api/types.gen"
import { abuseipdbCheckUrl, shortAgoText } from "@/lib/abuseipdb"
import { bgpAsUrl, crowdsecCtiUrl, decisionLabel, winningDecision } from "@/lib/crowdsec"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import { formatNumber } from "@/lib/format-number"
import { scenarioText } from "@/lib/scenario-name"
import { cn } from "@/lib/utils"
import type { BanDuration } from "../lib/actions"
import { inspectorUrl } from "../lib/links"
import { toSixHour } from "../lib/stats"
import type { RecentLookup } from "../lib/storage"
import { AbuseCheck } from "./AbuseCheck"
import { BanMenu } from "./BanMenu"
import { CopyIp } from "./CopyIp"
import { IpChip } from "./IpChip"
import {
  actionRowFor,
  applyDecisions,
  banFromPopup,
  exactDecision,
  fetchDecisions,
  loadLookup,
  profileBuckets,
  queueRecent,
  rangeDecision,
  recentFrom,
  showAbuseCheck,
  unbanFromPopup,
  unbanToast,
  worthRemembering,
  type ActionRow,
  type DecisionSnapshot,
  type LookupData,
} from "./lookup"
import { CAPTCHA_TEXT_CLASS } from "./marks"
import type { PopupSession } from "./open-context"
import { formatErrorRate, type StatsRange } from "./site-stats"
import { Chart, ErrorCount, Hits, Kpi, Label, ListRow, RangeSwitch, cardClass } from "./SiteStats"

function MetaLine({ ip, data }: { ip: string; data: LookupData | undefined }) {
  const location = data?.location ?? null
  const profile = data?.profile ?? null
  const asUrl = bgpAsUrl(profile?.asn)
  const parts: ReactNode[] = []
  if (location) {
    parts.push(
      <span key="place" className="inline-flex items-center gap-1.5">
        <CountryFlag code={location.countryCode} name={location.countryName} />
        {`${location.city ?? location.countryName}, ${location.countryCode}`}
      </span>,
    )
  }
  if (profile?.asn != null && asUrl) {
    parts.push(
      <ExternalLink key="asn" href={asUrl} className={linkClass}>
        {`AS${profile.asn}${profile.asnOrganization ? ` ${profile.asnOrganization}` : ""}`}
      </ExternalLink>,
    )
  }
  parts.push(
    <ExternalLink key="cti" href={crowdsecCtiUrl(ip)} className={linkClass}>
      CrowdSec CTI
    </ExternalLink>,
  )
  parts.push(
    <ExternalLink key="abuseipdb" href={abuseipdbCheckUrl(ip)} className={linkClass}>
      AbuseIPDB
    </ExternalLink>,
  )
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11.5px] text-muted-foreground">
      {parts.flatMap((part, index) =>
        index === 0
          ? [part]
          : [
              <span key={`dot-${index}`} aria-hidden>
                ·
              </span>,
              part,
            ],
      )}
    </p>
  )
}

const linkClass =
  "text-muted-foreground underline decoration-input underline-offset-2 hover:text-foreground"

function categoryBadge(profile: IpProfileResponse | null) {
  if (profile?.asnCategory === "hosting") {
    return { label: "Hosting", hint: "The ASN is on the list of hosting and datacenter networks" }
  }
  if (profile?.asnCategory === "drop") {
    return { label: "DROP ASN", hint: "The ASN is on Spamhaus ASN-DROP" }
  }
  return null
}

function useSettled<T>(load: Promise<T | null>): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const settled = await load
      if (!cancelled) setValue(settled)
    })()
    return () => {
      cancelled = true
    }
  }, [load])
  return value
}

function Badges({
  ip,
  session,
  data,
  decisions,
  busy,
  onRetryDecisions,
}: {
  ip: string
  session: PopupSession
  data: LookupData | undefined
  decisions: DecisionSnapshot | null
  busy: boolean
  onRetryDecisions: () => void
}) {
  const shown = decisions?.decisions ?? []
  const exact = exactDecision(shown)
  const range = rangeDecision(shown)
  const category = categoryBadge(data?.profile ?? null)
  const abuse = showAbuseCheck(ip, useSettled(session.abuseStatus))
  const badgeClass = "h-auto max-w-full cursor-help text-left break-words whitespace-normal"
  const toneClass = (type: string) => cn(badgeClass, type === "captcha" && CAPTCHA_TEXT_CLASS)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {exact && (
        <DecisionBadge
          type={exact.type}
          hover="tooltip"
          className={toneClass(exact.type)}
          title={`Origin: ${exact.origin}`}
        >
          {decisionLabel(exact.type)} · {scenarioText(exact.scenario)} ·{" "}
          {timeLeftText(exact.duration)}
        </DecisionBadge>
      )}
      {range && (
        <DecisionBadge
          type={range.type}
          hover="tooltip"
          className={toneClass(range.type)}
          title={`A ${range.type} decision on ${range.ip} covers this IP`}
        >
          {decisionLabel(range.type)} · <span className="font-mono">{range.ip}</span> ·{" "}
          {timeLeftText(range.duration)}
        </DecisionBadge>
      )}
      {data?.dropSblId && (
        <DropBadge
          variant="long"
          sblId={data.dropSblId}
          linked
          hover="tooltip"
          className="cursor-help"
        />
      )}
      {abuse && <AbuseCheck ip={ip} client={session.client} identity={session.stored} />}
      {category && (
        <BadgeHint hint={category.hint} hover="tooltip">
          <Badge variant="outline" className="cursor-help font-normal text-muted-foreground">
            {category.label}
          </Badge>
        </BadgeHint>
      )}
      {decisions?.failed && (
        <span className="flex basis-full items-center gap-2 text-xs text-muted-foreground">
          CrowdSec decisions didn't load.
          <Button
            variant="outline"
            size="xs"
            className="h-[22px] rounded-md px-[7px] text-[11.5px] font-medium"
            disabled={busy}
            onClick={onRetryDecisions}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
            Retry
          </Button>
        </span>
      )}
    </div>
  )
}

function SubHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={cn(
        "mb-1.5 text-[11px] font-normal tracking-[.06em] text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </h3>
  )
}

function StatsCard({
  data,
  range,
  onRange,
  onRetry,
}: {
  data: LookupData | undefined
  range: StatsRange
  onRange: (range: StatsRange) => void
  onRetry: () => void
}) {
  const profile = data?.profile ?? null
  const shownRange = data?.shownRange ?? range
  const now = Date.now()
  let body: ReactNode
  if (data === undefined) {
    body = (
      <div className="grid gap-2.5" aria-busy="true" aria-label="Loading the IP's traffic">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  } else if (data.profileFailure) {
    body = (
      <div className="grid justify-items-start gap-2 text-[12.5px] text-muted-foreground">
        <p>{data.profileFailure.detail ?? "The IP's traffic didn't load."}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw />
          Try again
        </Button>
      </div>
    )
  } else if (data.neverLogged || !profile) {
    body = (
      <p className="text-[12.5px] text-muted-foreground">
        No requests from this IP in the last 7 days
      </p>
    )
  } else {
    const hourly = profileBuckets(profile.series, data.start, data.end)
    const ago = (at: string | null) => (at ? shortAgoText(at, now) : "-")
    body = (
      <>
        <div className="grid grid-cols-4 gap-2">
          <Kpi value={formatNumber(profile.totalRequests)} label="requests" />
          <Kpi
            value={formatErrorRate(profile.totalRequests > 0 ? profile.errorRate : null)}
            label="errors"
            alert={profile.status4xx + profile.status5xx > 0}
          />
          <Kpi value={ago(profile.firstSeen)} label="first seen" />
          <Kpi value={ago(profile.lastSeen)} label="last seen" />
        </div>
        <div className="mt-2.5">
          <Chart
            buckets={shownRange === "7d" ? toSixHour(hourly) : hourly}
            height={40}
            label={`Requests per ${shownRange === "24h" ? "hour" : "6 hours"}, errors in red`}
          />
        </div>
      </>
    )
  }
  return (
    <Card className={cardClass}>
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">
          {shownRange === "24h" ? "Last 24 hours" : "Last 7 days"}
        </h2>
        <RangeSwitch range={range} onChange={onRange} />
      </div>
      {body}
    </Card>
  )
}

function TrafficCard({ profile }: { profile: IpProfileResponse }) {
  const hosts = profile.hosts
  const paths = profile.paths
  const userAgent = profile.userAgents[0]?.userAgent
  if (hosts.length === 0 && paths.length === 0 && !userAgent) return null
  const maxHost = Math.max(1, ...hosts.map((host) => host.hits))
  return (
    <Card className={cardClass}>
      {hosts.length > 0 && (
        <section>
          <SubHeading>Targets</SubHeading>
          <div className="grid gap-1">
            {hosts.map((host) => (
              <ListRow key={host.host ?? ""} share={host.hits / maxHost}>
                <Label>{host.host ?? "(no host)"}</Label>
                <ErrorCount count={host.errorHits} />
                <Hits count={host.hits} />
              </ListRow>
            ))}
          </div>
        </section>
      )}
      {paths.length > 0 && (
        <section className={cn(hosts.length > 0 && "mt-2.5")}>
          <SubHeading>Paths</SubHeading>
          <div className="grid gap-1">
            {paths.map((path) => (
              <ListRow key={`${path.host ?? ""}|${path.url}`} share={0}>
                <Label className="font-mono text-xs">
                  <span title={path.host ? `${path.host}${path.url}` : path.url}>{path.url}</span>
                </Label>
                <ErrorCount count={path.errorHits} />
                <Hits count={path.hits} />
              </ListRow>
            ))}
          </div>
        </section>
      )}
      {userAgent && (
        <section className={cn((hosts.length > 0 || paths.length > 0) && "mt-2.5")}>
          <SubHeading>User agent</SubHeading>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={userAgent}>
            {userAgent}
          </p>
        </section>
      )}
    </Card>
  )
}

function Actions({
  ip,
  session,
  action,
  busy,
  onBan,
  onUnban,
}: {
  ip: string
  session: PopupSession
  action: ActionRow
  busy: boolean
  onBan: (duration: BanDuration) => void
  onUnban: () => void
}) {
  const button = "h-8 flex-1 text-[12.5px]"
  return (
    <footer className="grid gap-2 border-t px-3 pt-2.5 pb-3">
      {action.kind === "remove-ip" && (
        <p className="text-[11.5px] text-muted-foreground">
          The {action.rangeType} decision on <span className="font-mono">{action.rangeValue}</span>{" "}
          stays.
        </p>
      )}
      <div className="flex gap-2">
        {action.kind === "ban" && <BanMenu ip={ip} busy={busy} onBan={onBan} />}
        {(action.kind === "unban" || action.kind === "remove-ip") && (
          <Button variant="outline" className={button} disabled={busy} onClick={onUnban}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />}
            {action.kind === "remove-ip" ? "Remove IP decision" : "Unban"}
          </Button>
        )}
        <Button asChild variant="outline" className={button}>
          <a href={inspectorUrl(session.stored.origin, ip)} target="_blank" rel="noreferrer">
            <ScanSearch />
            Open in inspector
          </a>
        </Button>
      </div>
    </footer>
  )
}

/** Screens 4 to 6: one IP, with Ban or Unban when the key may write.
 *  `onDecisions` gets each confirmed decisions read and `onRecent` the
 *  recent list after each write to it; both may run after unmount.
 *  `onStale` runs, in place of the rest, when a Ban or Unban found the
 *  connection changed since the session opened and sent nothing. */
export function Lookup({
  session,
  ip,
  onDecisions,
  onRecent,
  onStale,
}: {
  session: PopupSession
  ip: string
  onDecisions?: (ip: string, decisions: DecisionView[]) => void
  onRecent?: (items: RecentLookup[]) => void
  onStale: () => void
}) {
  const [range, setRange] = useState<StatsRange>("7d")
  const [results, setResults] = useState<Partial<Record<StatsRange, LookupData>>>({})
  const [snapshot, setSnapshot] = useState<DecisionSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const snapshotRef = useRef<DecisionSnapshot | null>(null)
  const readSeq = useRef(0)
  const remembered = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const knownWeek = results["7d"]?.profileFailure === null ? results["7d"] : null
  const data = range === "24h" && knownWeek?.neverLogged ? knownWeek : results[range]
  const missing = data === undefined
  const { client, access, dropIndex, stored } = session
  // Shown while the other range loads, so the header doesn't flash.
  const shown = data ?? results["7d"] ?? results["24h"]

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const applyRead = (read: {
    decisions: DecisionView[] | null
    seq: number
    afterWrite: boolean
  }): DecisionSnapshot | null => {
    const next = applyDecisions(snapshotRef.current, read)
    if (next !== snapshotRef.current) {
      snapshotRef.current = next
      setSnapshot(next)
      if (access.crowdsec && next !== null && !next.failed) onDecisions?.(ip, next.decisions)
    }
    return next
  }

  const remember = (lookup: LookupData, decisions: DecisionSnapshot | null) => {
    const current = decisions
      ? { ...lookup, decisions: decisions.decisions, decisionsFailed: decisions.failed }
      : lookup
    void queueRecent(
      stored,
      ip,
      (previous) => recentFrom(ip, current, Date.now(), previous),
      onRecent,
    )
  }

  useEffect(() => {
    if (!missing) return
    const seq = ++readSeq.current
    let cancelled = false
    void (async () => {
      const loaded = await loadLookup(client, ip, range, access, dropIndex, new Date(), {
        knownWeek,
      })
      if (cancelled) return
      setResults((previous) => ({
        ...previous,
        [range]: loaded,
        ...(loaded.week ? { "7d": loaded.week } : {}),
      }))
      const decisions = applyRead({
        decisions: loaded.decisionsFailed ? null : loaded.decisions,
        seq,
        afterWrite: false,
      })
      if (!remembered.current && worthRemembering(loaded, access)) {
        remembered.current = true
        remember(loaded, decisions)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [range, missing, knownWeek, client, ip, access, dropIndex, stored])

  const refreshDecisions = async (afterWrite: boolean) => {
    const seq = ++readSeq.current
    const fresh = await fetchDecisions(client, ip)
    const next = applyRead({ decisions: fresh, seq, afterWrite })
    if (fresh && shown) remember(shown, next)
  }

  const action = actionRowFor(access, snapshot?.decisions ?? null, snapshot?.failed ?? false)

  const ban = async (duration: BanDuration) => {
    setBusy(true)
    const sent = await banFromPopup(session, ip, duration)
    if (sent.stale) return onStale()
    const result = sent.value
    if (result.ok) {
      toast.success(result.message)
      await refreshDecisions(true)
    } else {
      toast.error(result.message)
    }
    setBusy(false)
  }

  const unban = async () => {
    const before = action
    setBusy(true)
    let seq = 0
    const sent = await unbanFromPopup(session, ip, () => {
      seq = ++readSeq.current
    })
    if (sent.stale) return onStale()
    const outcome = sent.value
    const next = applyRead({ decisions: outcome.decisions, seq, afterWrite: true })
    const message = unbanToast(ip, before, outcome)
    if (message.ok) toast.success(message.message)
    else toast.error(message.message)
    if (outcome.decisions && shown) remember(shown, next)
    setBusy(false)
  }

  const retryDecisions = async () => {
    setBusy(true)
    await refreshDecisions(false)
    setBusy(false)
  }

  const retry = () =>
    setResults((previous) => {
      const { [range]: _failed, ...rest } = previous
      return rest
    })

  const winning = winningDecision(snapshot?.decisions ?? [])
  const profile = data && !data.neverLogged ? data.profile : null

  return (
    <>
      <main className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-auto p-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 ref={headingRef} tabIndex={-1} className="min-w-0 outline-none">
              <IpChip
                ip={ip}
                mark={{ decisionType: winning?.type ?? null, dropSblId: shown?.dropSblId ?? null }}
                className={cn(
                  "block truncate text-base font-semibold tracking-tight",
                  winning || shown?.dropSblId ? "px-2" : "px-0",
                )}
              />
            </h1>
            <CopyIp ip={ip} />
          </div>
          <MetaLine ip={ip} data={shown} />
          <Badges
            ip={ip}
            session={session}
            data={shown}
            decisions={snapshot}
            busy={busy}
            onRetryDecisions={() => void retryDecisions()}
          />
        </div>
        <StatsCard data={data} range={range} onRange={setRange} onRetry={retry} />
        {profile && profile.totalRequests > 0 && <TrafficCard profile={profile} />}
      </main>
      <Actions
        ip={ip}
        session={session}
        action={action}
        busy={busy}
        onBan={(duration) => void ban(duration)}
        onUnban={() => void unban()}
      />
    </>
  )
}
