/**
 * Top IPs by geo-event count for the geo-logs page, across all locations.
 */
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
import { useGeoLogTopIps } from "@/lib/queries"
import { TablePaginationFooter, usePagedRows } from "@/components/analytics/table-pagination"

export function GeoTopIpsTable() {
  const { data, isLoading } = useGeoLogTopIps({ limit: 10 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top IPs</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IP</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => (
                  <TableRow key={row.ipAddress}>
                    <TableCell className="font-mono text-xs">{row.ipAddress}</TableCell>
                    <TableCell>{row.countryCode ?? "-"}</TableCell>
                    <TableCell>{row.city ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
                  </TableRow>
                ))}
                {pageItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No geo events match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
