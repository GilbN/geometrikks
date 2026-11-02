/**
 * Dashboard "Traffic origin" KPIs, fed by the analytics /top-asns endpoint.
 *
 * Owns its own query instead of extending /summary: the summary CAGGs carry
 * no ASN dimension, and adding one means drop and recreate, which discards
 * history older than raw retention. The query key matches the analytics
 * page's (same default limit, same range, no filters), so TanStack serves
 * one cached response to both pages.
 *
 * The hook depends on AnalyticsFiltersContext, whose default is EMPTY_FILTERS
 * precisely so dashboard-shared hooks work outside the analytics provider.
 */
import { Network, OctagonX, Server } from "lucide-react"

import { ErrorBanner } from "@/components/error-banner"
import { SectionHeader } from "@/components/section-header"
import { StatCard, StatCardSkeleton, StatGrid } from "@/components/dashboard/statcard"
import { StatInfo } from "@/components/dashboard/stat-info"
import { formatNumber } from "@/lib/api"
import { asnCoverage } from "@/lib/asn-coverage"
import { dropTrafficSubtitle } from "@/lib/drop-lists"
import { useTopAsns } from "@/lib/queries"

function DropTrafficHelp() {
  return (
    <>
      <p>
        Requests from networks on Spamhaus's ASN-DROP list. DROP stands for
        Don't Route Or Peer. It names networks run by spam and cybercrime
        operations, so traffic from them is almost never legitimate.
      </p>
      <p>
        The name is the list's. GeoMetrikks has not dropped or blocked these
        requests.
      </p>
    </>
  )
}

function HostingTrafficHelp({ dropShown }: { dropShown: boolean }) {
  return (
    <>
      <p>
        Requests from networks on a bundled community list of hosting, VPN and
        datacenter operators. Traffic from these is mostly bots, scanners and
        VPN users rather than people browsing from home. Browse the list under
        Settings &gt; About.
      </p>
      {dropShown && <p>Networks on Spamhaus DROP count on the Spamhaus DROP card instead.</p>}
    </>
  )
}

export function TrafficOriginStats() {
  // Default limit on purpose: a different limit would be a different query
  // key and the analytics page's cached response could not be reused. Only
  // items[0] is shown; category totals are exact regardless of limit.
  const { data, isLoading, isError, error } = useTopAsns()

  const { classified, hostingShare, dropShare, dropHits, coverage, hasData } = asnCoverage(
    data?.categories,
    data?.totalRequests ?? 0,
  )

  // A failed request must not look like "no ASN data"; the section would
  // vanish silently while the rest of Summary renders. Shown only when there
  // is no usable data at all. A background refetch failure keeps the last
  // good values, and stale KPIs beat an error card.
  if (isError && !data) {
    return (
      <>
        <SectionHeader>Traffic Origin</SectionHeader>
        <ErrorBanner
          title={`Failed to load ASN statistics: ${error?.message ?? "Unknown error"}`}
        />
      </>
    )
  }

  // Placeholders on the initial load so the section does not pop in and
  // shift the page once the query lands. On an install with no ASN data
  // they flash once and vanish.
  if (isLoading) {
    return (
      <>
        <SectionHeader>Traffic Origin</SectionHeader>
        <StatGrid>
          <StatCardSkeleton />
          <StatCardSkeleton />
        </StatGrid>
      </>
    )
  }

  // Nothing enriched yet (fresh install, ASN disabled, history predating the
  // feature). Render nothing; the analytics page explains it and names the
  // backfill command.
  if (!data || !hasData) return null

  const top = data.items[0]
  const dropAsnCount = data.dropAsnCount

  return (
    <>
      <SectionHeader>Traffic Origin</SectionHeader>
      <StatGrid className={dropShare !== null ? "md:grid-cols-3" : undefined}>
        {dropShare !== null && (
          <StatCard
            title="Spamhaus DROP"
            info={
              <StatInfo label="What Spamhaus DROP traffic is">
                <DropTrafficHelp />
              </StatInfo>
            }
            value={`${dropShare.toFixed(1)}%`}
            valueClassName="text-destructive"
            subtitle={dropTrafficSubtitle(dropHits, dropAsnCount, classified, coverage)}
            icon={OctagonX}
            iconClassName="text-destructive"
          />
        )}
        <StatCard
          title="Hosting Traffic"
          info={
            <StatInfo label="What hosting traffic is">
              <HostingTrafficHelp dropShown={dropShare !== null} />
            </StatInfo>
          }
          value={`${hostingShare.toFixed(1)}%`}
          subtitle={
            coverage < 99.5
              ? `of ${formatNumber(classified)} classified requests (${coverage.toFixed(0)}% of range)`
              : `of ${formatNumber(classified)} requests`
          }
          icon={Server}
        />
        <StatCard
          title="Top Network"
          value={top?.organization ?? `AS${top?.asn ?? "-"}`}
          valueClassName="text-xl max-md:line-clamp-2 max-md:text-base max-md:break-words md:truncate"
          subtitle={top ? `AS${top.asn} - ${formatNumber(top.hits)} requests` : "No ASN data"}
          icon={Network}
        />
      </StatGrid>
    </>
  )
}
