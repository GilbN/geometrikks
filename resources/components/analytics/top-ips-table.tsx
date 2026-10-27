import { useMemo } from "react"
import { CountryLabel } from "@/components/country-flag"
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
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { analyticsFilterTargets } from "@/lib/ip-filter-targets"
import { useAnalyticsFilters } from "@/lib/analytics-filters-context"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopIpsTable() {
  const { data, isLoading } = useTopIpStats({ limit: 25 })
  const { filters, setFilters } = useAnalyticsFilters()
  const filterTargetsFor = useMemo(() => analyticsFilterTargets(filters, setFilters), [filters, setFilters])
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  // Keep banned badges in sync with external cscli/console decisions.
  useCrowdsecLiveUpdates()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Top IPs</CardTitle>
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
              <IpFilterTargetsProvider targetsFor={filterTargetsFor}>
                <TableBody>
                  {pageItems.map((row) => (
                    <TableRow key={row.ipAddress}>
                      <TableCell className="font-mono text-xs">
                        <IpLabel ip={row.ipAddress} />
                        <IpActionsMenu ip={row.ipAddress} countryCode={row.countryCode} city={row.city} />
                      </TableCell>
                      <TableCell>{row.countryCode ? <CountryLabel code={row.countryCode} /> : "-"}</TableCell>
                      <TableCell>{row.city ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.errorHits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(row.totalBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </IpFilterTargetsProvider>
            </Table>
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
