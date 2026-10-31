import { useMemo } from "react"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { useFitLayout } from "@/components/data/narrow-layout"
import { RankedNarrowCell, RankedNarrowHeader } from "@/components/data/ranked-narrow"
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
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(pageItems.map((row) => row.ipAddress).join())

  return (
    <Card ref={layoutRef}>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Top IPs</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table className={narrow ? "table-fixed" : undefined}>
              {narrow ? (
                <RankedNarrowHeader label="IP" valueLabel="Hits" />
              ) : (
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
              )}
              <IpFilterTargetsProvider targetsFor={filterTargetsFor}>
                <TableBody>
                  {pageItems.map((row) => narrow ? (
                    <TableRow key={row.ipAddress}>
                      <RankedNarrowCell
                        primary={
                          <>
                            <IpLabel ip={row.ipAddress} className="truncate font-mono text-xs" />
                            <IpActionsMenu ip={row.ipAddress} countryCode={row.countryCode} city={row.city} />
                          </>
                        }
                        value={formatNumber(row.hits)}
                        secondary={
                          <>
                            {(row.countryCode || row.city) && (
                              <span className="flex items-center gap-1">
                                <CountryFlag code={row.countryCode} standalone />
                                {[row.countryCode, row.city].filter(Boolean).join(", ")}
                              </span>
                            )}
                            <span>{formatNumber(row.errorHits)} {row.errorHits === 1 ? "error" : "errors"}</span>
                            <span>{formatBytes(row.totalBytes)}</span>
                          </>
                        }
                      />
                    </TableRow>
                  ) : (
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
