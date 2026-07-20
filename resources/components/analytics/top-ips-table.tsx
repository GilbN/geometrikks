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
import { useCrowdsecLiveUpdates, useTopIpStats } from "@/lib/queries"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopIpsTable() {
  const { data, isLoading } = useTopIpStats({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  // Keep banned badges in sync with external cscli/console decisions.
  useCrowdsecLiveUpdates()

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
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => (
                  <TableRow key={row.ip_address}>
                    <TableCell className="font-mono text-xs">
                      {row.ip_address}
                      <IpBanControls ip={row.ip_address} />
                    </TableCell>
                    <TableCell>{row.country_code ?? "-"}</TableCell>
                    <TableCell>{row.city ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.error_hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(row.total_bytes)}</TableCell>
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
