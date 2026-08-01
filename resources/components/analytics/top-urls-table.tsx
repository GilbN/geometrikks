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
import { formatBytes, formatDuration, formatNumber } from "@/lib/api"
import { useTopUrls } from "@/lib/queries"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopUrlsTable() {
  const { data, isLoading } = useTopUrls({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top URLs</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                  <TableHead className="text-right">Avg time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => (
                  <TableRow key={row.url}>
                    <TableCell className="font-mono text-xs max-w-[420px] truncate">{row.url}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.errorHits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(row.totalBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDuration(row.avgRequestTime * 1000)}</TableCell>
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
