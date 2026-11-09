import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { AsnCategoryInfo } from "@/components/analytics/asn-category-info"
import { DropCredit } from "@/components/drop/drop-credit"
import { formatBytes, formatNumber } from "@/lib/api"
import { asnCoverage, headlineAsnCategory, type HeadlineAsnCategory } from "@/lib/asn-coverage"
import { dropAsnFreshness } from "@/lib/drop-lists"
import { useAbout, useCrowdsecStatus, useTopAsns } from "@/lib/queries"
import { CategoryBadge } from "./top-asns-table"

const ORIGIN_PHRASE: Record<HeadlineAsnCategory["category"], string> = {
  drop: "networks on Spamhaus's ASN-DROP list",
  hosting: "hosting and datacenter networks",
}

export function TrafficOriginCard() {
  const { data, isError, error } = useTopAsns({ limit: 25 })
  const { data: about } = useAbout()
  const { data: crowdsecStatus } = useCrowdsecStatus()

  const drop = data?.categories.find((c) => c.category === "drop")
  const hosting = data?.categories.find((c) => c.category === "hosting")
  const other = data?.categories.find((c) => c.category === "other")
  const totalRequests = data?.totalRequests ?? 0
  // See asn-coverage.ts for why the share and the coverage use different
  // denominators.
  const dropFreshness = dropAsnFreshness(about?.dropLists)
  const { classified, unenriched, hostingShare: share, dropShare, coverage } = asnCoverage(
    data?.categories,
    totalRequests,
  )
  const headline = headlineAsnCategory(data?.categories)

  return (
    <Card className="@container">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Traffic origin
          <AsnCategoryInfo />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isError && !data ? (
          <p className="text-sm text-destructive">
            Failed to load ASN statistics: {error?.message ?? "Unknown error"}
          </p>
        ) : !data ? (
          <Skeleton className="h-32 w-full" />
        ) : classified === 0 || !headline ? (
          <p className="text-sm text-muted-foreground">
            None of the {formatNumber(totalRequests)} requests in this range
            have ASN data; requests are enriched from the time the ASN
            database is first loaded. Run{" "}
            <code className="font-mono">litestar backfill-asn --table access-logs</code>{" "}
            to fill in history.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">{((headline.hits / classified) * 100).toFixed(1)}%</span>
              <span className="text-muted-foreground">
                of {formatNumber(classified)} requests with ASN data came from{" "}
                {ORIGIN_PHRASE[headline.category]}
              </span>
            </div>
            {unenriched > 0 && (
              <p className="text-xs text-muted-foreground">
                Covers {coverage.toFixed(1)}% of this range;{" "}
                {formatNumber(unenriched)} of {formatNumber(totalRequests)} requests
                have no ASN data and are excluded above.
              </p>
            )}
            <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
              {dropShare !== null && (
                <div className="h-full bg-destructive" style={{ width: `${dropShare}%` }} />
              )}
              <div className="h-full bg-primary" style={{ width: `${share}%` }} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[drop, hosting, other].map(
                  (cat) =>
                    cat && (
                      <TableRow key={cat.category}>
                        <TableCell className="whitespace-normal">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <CategoryBadge category={cat.category} />
                            {cat.category === "drop" && (
                              <span className="hidden text-xs text-muted-foreground @lg:inline">
                                networks with no legitimate traffic
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(cat.hits)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBytes(cat.totalBytes)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {classified > 0 ? ((cat.hits / classified) * 100).toFixed(1) : "0.0"}%
                        </TableCell>
                      </TableRow>
                    ),
                )}
                {unenriched > 0 && (
                  <TableRow className="text-muted-foreground">
                    <TableCell>No ASN data</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(unenriched)}</TableCell>
                    <TableCell className="text-right tabular-nums">-</TableCell>
                    <TableCell className="text-right tabular-nums">-</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {drop && (
              <DropCredit
                updatedAt={dropFreshness.updatedAt}
                stale={dropFreshness.stale}
                securityLink={crowdsecStatus?.enabled === true}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
