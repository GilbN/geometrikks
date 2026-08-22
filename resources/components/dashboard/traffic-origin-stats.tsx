/**
 * Dashboard "Traffic origin" KPIs, fed by the analytics /top-asns endpoint.
 *
 * Owns its own query rather than riding /summary: the summary CAGGs carry no
 * ASN dimension (adding one means drop+recreate, which discards history older
 * than raw retention), and /summary runs twice per load for its
 * previous-period comparison. TanStack shares this fetch with the analytics
 * page whenever the selected range matches.
 *
 * The hook depends on AnalyticsFiltersContext, whose default is EMPTY_FILTERS
 * precisely so dashboard-shared hooks work outside the analytics provider.
 */
import { Network, Server } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { SectionHeader } from "@/components/dashboard/section-header"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { formatNumber } from "@/lib/api"
import { asnCoverage } from "@/lib/asn-coverage"
import { useTopAsns } from "@/lib/queries"

export function TrafficOriginStats() {
  // limit=1: only the leading organization is shown here. Category totals are
  // computed server-side across every ASN, so they stay exact regardless.
  const { data, isLoading, isError, error } = useTopAsns({ limit: 1 })

  const { classified, hostingShare, coverage, hasData } = asnCoverage(
    data?.categories,
    data?.totalRequests ?? 0,
  )

  // A failed request must not look like "you have no ASN data": without this
  // the section would vanish while the rest of Summary renders normally, and
  // nothing would say the query broke. Only when there is no usable data at
  // all - a background refetch failure still has the last good values, and
  // stale KPIs beat an error card.
  if (isError && !data) {
    return (
      <>
        <SectionHeader>Traffic Origin</SectionHeader>
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">
              Failed to load ASN statistics: {error?.message ?? "Unknown error"}
            </p>
          </CardContent>
        </Card>
      </>
    )
  }

  // Placeholders on the initial load so the section does not pop in and
  // shift the page once the query lands. On an install with no ASN data
  // they flash once and vanish; the alternative is a layout jump on every
  // load for everyone who has data.
  if (isLoading) {
    return (
      <>
        <SectionHeader>Traffic Origin</SectionHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
      </>
    )
  }

  // Nothing enriched yet (fresh install, ASN disabled, history predating the
  // feature): stay silent rather than parking an explanatory card on a
  // glanceable KPI page. The analytics page explains it and names the
  // backfill command.
  if (!data || !hasData) return null

  const top = data.items[0]

  return (
    <>
      <SectionHeader>Traffic Origin</SectionHeader>
      <div className="grid gap-4 md:grid-cols-2">
        <StatCard
          title="Hosting Traffic"
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
          valueClassName="truncate text-xl"
          subtitle={top ? `AS${top.asn} - ${formatNumber(top.hits)} requests` : "No ASN data"}
          icon={Network}
        />
      </div>
    </>
  )
}
