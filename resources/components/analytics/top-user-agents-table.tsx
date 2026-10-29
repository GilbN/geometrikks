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
import { formatNumber } from "@/lib/api"
import { useTopUserAgents } from "@/lib/queries"
import { useFitLayout } from "@/components/data/narrow-layout"
import { RankedNarrowCell, RankedNarrowHeader } from "@/components/data/ranked-narrow"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopUserAgentsTable() {
  const { data, isLoading } = useTopUserAgents({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(pageItems.map((row) => row.userAgent).join())

  return (
    <Card ref={layoutRef}>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Top user agents</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table className={narrow ? "table-fixed" : undefined}>
              {narrow ? (
                <RankedNarrowHeader label="User agent" valueLabel="Hits" />
              ) : (
                <TableHeader>
                  <TableRow>
                    <TableHead>User agent</TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                {pageItems.map((row) => narrow ? (
                  <TableRow key={row.userAgent}>
                    <RankedNarrowCell
                      primary={<span className="line-clamp-2 break-all font-mono text-xs" title={row.userAgent}>{row.userAgent}</span>}
                      value={formatNumber(row.hits)}
                    />
                  </TableRow>
                ) : (
                  <TableRow key={row.userAgent}>
                    <TableCell className="font-mono text-xs max-w-[640px] truncate">{row.userAgent}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
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
