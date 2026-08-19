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
import { formatBytes, formatNumber } from "@/lib/api"
import { useTopAsns } from "@/lib/queries"
import { CategoryBadge } from "./top-asns-table"

export function TrafficOriginCard() {
  const { data, isLoading } = useTopAsns({ limit: 25 })

  const datacenter = data?.categories.find((c) => c.category === "datacenter")
  const other = data?.categories.find((c) => c.category === "other")
  // Two denominators, deliberately: the share is of CLASSIFIED traffic (the
  // only traffic whose origin is known), while coverage is judged against
  // every request in the range. Dividing by the classified total alone would
  // report "100% datacenter" on an install whose history predates ASN
  // enrichment.
  const classified = (datacenter?.hits ?? 0) + (other?.hits ?? 0)
  const totalRequests = data?.totalRequests ?? 0
  const unenriched = Math.max(0, totalRequests - classified)
  const share = classified > 0 ? ((datacenter?.hits ?? 0) / classified) * 100 : 0
  const coverage = totalRequests > 0 ? (classified / totalRequests) * 100 : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Traffic origin</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-32 w-full" />
        ) : classified === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of the {formatNumber(totalRequests)} requests in this range
            have ASN data; requests are enriched from the time the ASN
            database is first loaded. Run <code className="font-mono">litestar backfill-asn</code>{" "}
            to fill in history.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">{share.toFixed(1)}%</span>
              <span className="text-muted-foreground">
                of {formatNumber(classified)} requests with ASN data came from
                datacenter networks
              </span>
            </div>
            {unenriched > 0 && (
              <p className="text-xs text-muted-foreground">
                Covers {coverage.toFixed(1)}% of this range;{" "}
                {formatNumber(unenriched)} of {formatNumber(totalRequests)} requests
                have no ASN data and are excluded above.
              </p>
            )}
            <div className="h-2.5 rounded-full bg-muted">
              <div
                className="h-2.5 rounded-full bg-geo-cyan"
                style={{ width: `${share}%` }}
              />
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
                {[datacenter, other].map(
                  (cat) =>
                    cat && (
                      <TableRow key={cat.category}>
                        <TableCell><CategoryBadge category={cat.category} /></TableCell>
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
