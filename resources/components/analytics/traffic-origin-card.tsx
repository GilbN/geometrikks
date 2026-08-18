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
  const total = (datacenter?.hits ?? 0) + (other?.hits ?? 0)
  const share = total > 0 ? ((datacenter?.hits ?? 0) / total) * 100 : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Traffic origin</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-32 w-full" />
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ASN data in this range yet; requests are enriched from the
            time the ASN database is first loaded.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">{share.toFixed(1)}%</span>
              <span className="text-muted-foreground">
                of {formatNumber(total)} requests came from datacenter networks
              </span>
            </div>
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
                          {total > 0 ? ((cat.hits / total) * 100).toFixed(1) : "0.0"}%
                        </TableCell>
                      </TableRow>
                    ),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
