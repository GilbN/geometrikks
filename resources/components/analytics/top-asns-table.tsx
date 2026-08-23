import { Badge } from "@/components/ui/badge"
import { AsnCategoryInfo } from "@/components/analytics/asn-category-info"
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
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function CategoryBadge({ category }: { category: "hosting" | "other" }) {
  return category === "hosting" ? (
    <Badge variant="secondary" className="gap-1.5">
      <span className="size-1.5 rounded-full bg-primary" />
      Hosting
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Other
    </Badge>
  )
}

export function TopAsnsTable() {
  const { data, isError, error } = useTopAsns({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Top ASNs</CardTitle>
      </CardHeader>
      <CardContent>
        {isError && !data ? (
          <p className="text-sm text-destructive">
            Failed to load ASN statistics: {error?.message ?? "Unknown error"}
          </p>
        ) : !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>ASN</TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1.5">
                      Category
                      <AsnCategoryInfo />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => (
                  <TableRow key={row.asn}>
                    <TableCell className="max-w-[420px] truncate" title={row.organization ?? undefined}>
                      {row.organization ?? "Unknown"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">AS{row.asn}</TableCell>
                    <TableCell><CategoryBadge category={row.category} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(row.totalBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
