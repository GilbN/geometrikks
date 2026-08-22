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
import { Network, Server } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { SectionHeader } from "@/components/dashboard/section-header"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { formatNumber } from "@/lib/api"
import { asnCoverage } from "@/lib/asn-coverage"
import { useTopAsns } from "@/lib/queries"

export function TrafficOriginStats() {
  // Default limit on purpose: a different limit would be a different query
  // key and the analytics page's cached response could not be reused. Only
  // items[0] is shown; category totals are exact regardless of limit.
  const { data, isLoading, isError, error } = useTopAsns()

  const { classified, hostingShare, coverage, hasData } = asnCoverage(
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
  // they flash once and vanish.
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
  // feature). Render nothing; the analytics page explains it and names the
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
