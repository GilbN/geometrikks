import { Link } from "@tanstack/react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DetailSheet } from "@/components/data/detail-sheet"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { isValidIp } from "@/lib/crowdsec"
import { useIpInspector } from "@/lib/ip-inspector"
import { useIpDecisions, useIpLatestAlert, useIpLocations, useIpProfile } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"
import { IpLatestRequests } from "./ip-latest-requests"
import { IpSignalsStrip } from "./ip-signals-strip"
import { IpStatsBlock } from "./ip-stats-block"
import { IpTopList } from "./ip-top-list"
import { bucketFloor, computeSignals } from "./signals"

export function IpInspectorSheet() {
  const { ip, close } = useIpInspector()
  const { range } = useTimeRange()
  const open = ip !== undefined
  const valid = open && isValidIp(ip)

  return (
    <DetailSheet
      open={open}
      onOpenChange={(next) => !next && close()}
      title={ip ?? ""}
      description={valid ? rangeSubtitle(range) : "Not a valid IP address"}
      className="sm:w-[min(36rem,100vw)] sm:max-w-xl"
    >
      {valid ? <IpInspectorBody ip={ip} /> : <p className="text-sm text-muted-foreground">Not a valid IP address.</p>}
    </DetailSheet>
  )
}

function IpInspectorBody({ ip }: { ip: string }) {
  const profileQuery = useIpProfile(ip)
  const decisions = useIpDecisions(ip)
  const latestAlert = useIpLatestAlert(ip)
  const locations = useIpLocations(ip)

  const profile = profileQuery.data
  const decision = decisions.data?.[0] ?? null
  const banned = decision !== null
  const banCreatedAt = latestAlert.data?.createdAt ?? null
  const primary = locations.data?.items?.[0]
  const signals = profile ? computeSignals({ profile, banned, banCreatedAt }) : []

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {primary && `${primary.city ?? primary.countryName}, ${primary.countryCode}`}
          {primary && profile?.asn != null && " · "}
          {profile?.asn != null && `AS${profile.asn}${profile.asnOrganization ? ` ${profile.asnOrganization}` : ""}`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {decision && (
            <Badge variant="destructive" title={`Origin: ${decision.origin}`}>
              Banned · {decision.scenario} · {decision.duration} left
            </Badge>
          )}
          <IpBanControls ip={ip} />
        </div>
      </header>

      <IpSignalsStrip signals={signals} />

      <section>
        {profileQuery.isLoading && <Skeleton className="h-40 w-full" />}
        {profileQuery.isError && (
          <div className="flex items-center justify-between text-sm text-destructive">
            <span>Could not load the profile.</span>
            <Button size="sm" variant="outline" onClick={() => void profileQuery.refetch()}>Retry</Button>
          </div>
        )}
        {profile && (
          <IpStatsBlock
            profile={profile}
            banCreatedAt={banCreatedAt ? bucketFloor(banCreatedAt, profile.granularity) : null}
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
        <IpTopList title="Paths" rows={profile.paths.map((p) => ({ label: p.url, hits: p.hits, errorHits: p.errorHits, mono: true }))} />
      )}
      {profile && (
        <IpTopList title="User agents" rows={profile.userAgents.map((u) => ({ label: u.userAgent, hits: u.hits }))} />
      )}

      {/* "Also seen from" mounts here in Task 6. */}

      <IpLatestRequests ip={ip} />

      <footer className="flex gap-2 border-t border-border/50 pt-3">
        <Button asChild size="sm" variant="outline">
          <Link to="/analytics" search={(prev) => ({ ...prev, ip: [ip], inspect: ip })}>Analytics →</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/access-logs" search={{ ip: [ip], inspect: ip }}>Access logs →</Link>
        </Button>
      </footer>
    </div>
  )
}
