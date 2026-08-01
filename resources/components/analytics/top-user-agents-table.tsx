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
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopUserAgentsTable() {
  const { data, isLoading } = useTopUserAgents({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top user agents</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User agent</TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => (
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
