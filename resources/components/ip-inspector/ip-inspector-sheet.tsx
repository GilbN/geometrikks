import { cloneElement, useEffect, useState, type ReactElement, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { BarChart3, Bug, ChevronDown, FileText, RotateCcw, RotateCw, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AbuseReportButton } from "@/components/abuse-report/abuse-report-dialog"
import { CountryFlag } from "@/components/country-flag"
import { DetailSheet } from "@/components/data/detail-sheet"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { ExternalLink } from "@/components/crowdsec/external-link"
import { IpBanAction } from "@/components/crowdsec/ip-ban-controls"
import { TimeRangePicker } from "@/components/time-range-picker"
import type { CustomTimeRange, TimeRangeValue } from "@/lib/api"
import { bgpAsUrl, crowdsecCtiUrl, decisionLabel, isValidIp, winningDecision } from "@/lib/crowdsec"
import { cn } from "@/lib/utils"
import { formatTs } from "@/lib/datetime"
import { useIpInspector } from "@/lib/ip-inspector"
import { useCrowdsecStatus, useIpDecisions, useIpLatestAlert, useIpLocations, useIpProfile } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"
import { IpLatestRequests } from "./ip-latest-requests"
import { IpLocationsBlock } from "./ip-locations-block"
import { IpSignalsStrip } from "./ip-signals-strip"
import { IpStatsBlock } from "./ip-stats-block"
import { IpTopList } from "./ip-top-list"
import { bucketFloor, computeSignals } from "./signals"

export function IpInspectorSheet() {
  const { ip, close } = useIpInspector()
  const { range, customRange, setRange, setCustomRange } = useTimeRange()
  const open = ip !== undefined
  const valid = open && isValidIp(ip)

  // What was selected before the first bar zoom, so "Back" restores it exactly.
  const [beforeZoom, setBeforeZoom] = useState<RangeSelection | null>(null)
  useEffect(() => setBeforeZoom(null), [ip])
  const zoomTo = (from: string, to: string) => {
    setBeforeZoom((prev) => prev ?? { range, customRange })
    setCustomRange({ from, to })
  }
  const restore = () => {
    if (!beforeZoom) return
    if (beforeZoom.range === "custom" && beforeZoom.customRange) setCustomRange(beforeZoom.customRange)
    else setRange(beforeZoom.range)
    setBeforeZoom(null)
  }

  return (
    <DetailSheet
      open={open}
      onOpenChange={(next) => !next && close()}
      title={
        // One row: IP, ban action, then the range picker; wraps only when a custom range needs the room.
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-2">
            {ip ?? ""}
            {valid && <HeaderBanAction ip={ip} />}
          </span>
          {valid && <SheetRangeControls beforeZoom={beforeZoom} onRestore={restore} />}
        </span>
      }
      description={valid ? undefined : "Not a valid IP address"}
      footer={valid ? <IpInspectorFooter ip={ip} /> : undefined}
      className="sm:w-[min(36rem,100vw)] sm:max-w-xl"
    >
      {valid ? <IpInspectorBody ip={ip} onZoom={zoomTo} /> : <p className="text-sm text-muted-foreground">Not a valid IP address.</p>}
    </DetailSheet>
  )
}

function sheetSubtitle(range: TimeRangeValue, customRange: CustomTimeRange | null): string {
  if (range === "custom" && customRange) {
    return `${formatTs(customRange.from, "hourly")} to ${formatTs(customRange.to, "hourly")}`
  }
  return rangeSubtitle(range)
}

type RangeSelection = { range: TimeRangeValue; customRange: CustomTimeRange | null }

/** The sheet subtitle doubles as the range picker; "Back" appears only after a bar zoom. */
function SheetRangeControls({ beforeZoom, onRestore }: { beforeZoom: RangeSelection | null; onRestore: () => void }) {
  const { range, customRange } = useTimeRange()
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <TimeRangePicker
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 p-0 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            {sheetSubtitle(range, customRange)}
            <ChevronDown className="size-3.5" />
          </Button>
        }
      />
      {beforeZoom && (
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" onClick={onRestore}>
          <RotateCcw className="size-3" />
          Back to {sheetSubtitle(beforeZoom.range, beforeZoom.customRange)}
        </Button>
      )}
    </span>
  )
}

// Shares the decisions query with the body via the query key; no second fetch.
function HeaderBanAction({ ip }: { ip: string }) {
  const decisions = useIpDecisions(ip)
  return <IpBanAction ip={ip} banned={(decisions.data?.length ?? 0) > 0} />
}

function IpInspectorBody({ ip, onZoom }: { ip: string; onZoom: (from: string, to: string) => void }) {
  const profileQuery = useIpProfile(ip)
  const crowdsecEnabled = useCrowdsecStatus().data?.enabled ?? false
  const decisions = useIpDecisions(ip)
  const latestAlert = useIpLatestAlert(ip)
  const locations = useIpLocations(ip)

  const profile = profileQuery.data
  const decision = winningDecision(decisions.data)
  const banned = decision !== null
  const banCreatedAt = latestAlert.data?.createdAt ?? null
  const primary = locations.data?.items?.[0]
  const asUrl = bgpAsUrl(profile?.asn)
  const signals = profile ? computeSignals({ profile, banned, banCreatedAt }) : []

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {primary && <CountryFlag code={primary.countryCode} name={primary.countryName} className="mr-1.5 inline-block align-[-1px]" />}
          {primary && `${primary.city ?? primary.countryName}, ${primary.countryCode}`}
          {primary && profile?.asn != null && " · "}
          {profile?.asn != null && asUrl && (
            <ExternalLink href={asUrl}>
              {`AS${profile.asn}${profile.asnOrganization ? ` ${profile.asnOrganization}` : ""}`}
            </ExternalLink>
          )}
          {crowdsecEnabled && (
            <>
              {(primary || profile?.asn != null) && " · "}
              <ExternalLink href={crowdsecCtiUrl(ip)}>CrowdSec CTI</ExternalLink>
            </>
          )}
        </p>
        {decision && (
          <DecisionBadge
            type={decision.type}
            className="h-auto max-w-full whitespace-normal break-words text-left"
            title={`Origin: ${decision.origin}`}
          >
            {decisionLabel(decision.type)} · {decision.scenario} · {decision.duration} left
          </DecisionBadge>
        )}
      </header>

      <IpSignalsStrip signals={signals} />

      <section>
        {profileQuery.isLoading && <Skeleton className="h-40 w-full" />}
        {profileQuery.isError && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-destructive">
            <span>Could not load the profile{profile ? ", showing the last result" : ""}.</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={profileQuery.isFetching}
              onClick={() => void profileQuery.refetch()}
            >
              <RotateCw className={cn("size-3", profileQuery.isFetching && "animate-spin")} />
              {profileQuery.isFetching ? "Retrying" : "Retry"}
            </Button>
          </div>
        )}
        {profile && (
          <IpStatsBlock
            profile={profile}
            banCreatedAt={banned && banCreatedAt ? bucketFloor(banCreatedAt, profile.granularity) : null}
            onZoom={onZoom}
          />
        )}
      </section>

      {profile && profile.hosts.some((h) => h.host !== null) && (
        <IpTopList
          title="Targets"
          bars
          rows={profile.hosts.map((h) => ({ label: h.host ?? "(no host)", hits: h.hits, errorHits: h.errorHits }))}
        />
      )}
      {profile && (
        <IpTopList title="Paths" rows={profile.paths.map((p) => ({ prefix: p.host ?? "(no host)", label: p.url, hits: p.hits, errorHits: p.errorHits, mono: true }))} />
      )}
      {profile && (
        <IpTopList title="User agents" rows={profile.userAgents.map((u) => ({ label: u.userAgent, hits: u.hits }))} />
      )}

      <IpLocationsBlock ip={ip} />

      <IpLatestRequests ip={ip} />
    </div>
  )
}

// Reads the profile through the body's query key, so it adds no request.
function IpInspectorFooter({ ip }: { ip: string }) {
  const profile = useIpProfile(ip).data
  return (
    <footer className="flex flex-wrap gap-2">
      <FooterLink icon={BarChart3} label="Analytics">
        <Link to="/analytics" search={{ ip: [ip], inspect: ip }} />
      </FooterLink>
      <FooterLink icon={FileText} label="Access logs">
        <Link to="/access-logs" search={{ ip: [ip], inspect: ip }} />
      </FooterLink>
      {profile && profile.malformedRequests > 0 && (
        <FooterLink icon={Bug} label="Debug logs">
          <Link to="/debug-logs" search={{ ip, malformed: "malformed", inspect: ip }} />
        </FooterLink>
      )}
      <span className="ml-auto">
        <AbuseReportButton subject={{ kind: "ip", ip, asn: profile?.asn, organization: profile?.asnOrganization }} />
      </span>
    </footer>
  )
}

/** A footer link: the label on wider screens, the sidebar's icon for the page
 *  on a phone, where the full-width sheet has no room for labeled buttons. */
function FooterLink({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children: ReactElement<{ children?: ReactNode; "aria-label"?: string }>
}) {
  return (
    <Button asChild size="sm" variant="outline" className="max-sm:w-8 max-sm:px-0" title={label}>
      {cloneElement(children, { "aria-label": label }, (
        <>
          <Icon className="sm:hidden" />
          <span className="max-sm:hidden">{label} →</span>
        </>
      ))}
    </Button>
  )
}
