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
import { useTopUrls } from "@/lib/queries"
import { useAnalyticsFilters } from "@/lib/analytics-filters-context"
import { hostFilterTarget } from "@/lib/ip-filter-targets"
import { FilterActionsMenu } from "@/components/ip-actions/filter-actions-menu"
import { formatDurationOrNa } from "@/lib/timing"
import { useFitLayout } from "@/components/data/narrow-layout"
import { RankedNarrowCell, RankedNarrowHeader } from "@/components/data/ranked-narrow"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function TopUrlsTable() {
  const { data, isLoading } = useTopUrls({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  const { filters, setFilters } = useAnalyticsFilters()
  const showHost = new Set(filters.hosts).size <= 1
  const hostMenu = (host: string) => (
    <FilterActionsMenu
      title={host}
      subtitle="Host"
      triggerTitle="Host actions"
      drawerKey="host-actions"
      target={hostFilterTarget(host, filters, setFilters)}
    />
  )
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(
    `${showHost}:${pageItems.map((row) => `${row.host ?? ""} ${row.url}`).join()}`,
  )

  return (
    <Card ref={layoutRef}>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Top URLs
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table className={narrow ? "table-fixed" : undefined}>
              {narrow ? (
                <RankedNarrowHeader label="Path" valueLabel="Hits" />
              ) : (
                <TableHeader>
                  <TableRow>
                    {showHost && <TableHead>Host</TableHead>}
                    <TableHead>Path</TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">Bytes</TableHead>
                    <TableHead className="text-right">Avg time</TableHead>
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                {pageItems.map((row) =>
                  narrow ? (
                    <TableRow key={`${row.host ?? ""} ${row.url}`}>
                      <RankedNarrowCell
                        primary={
                          <span
                            className="line-clamp-2 break-all font-mono text-xs"
                            title={row.url}
                          >
                            {row.url}
                          </span>
                        }
                        value={formatNumber(row.hits)}
                        secondary={
                          <>
                            {showHost && row.host && (
                              <span className="flex min-w-0 items-center gap-1">
                                <span className="min-w-0 truncate" title={row.host}>
                                  {row.host}
                                </span>
                                {hostMenu(row.host)}
                              </span>
                            )}
                            <span>
                              {formatNumber(row.errorHits)}{" "}
                              {row.errorHits === 1 ? "error" : "errors"}
                            </span>
                            <span>{formatBytes(row.totalBytes)}</span>
                            {row.avgRequestTime != null && (
                              <span>{formatDurationOrNa(row.avgRequestTime)} avg</span>
                            )}
                          </>
                        }
                      />
                    </TableRow>
                  ) : (
                    <TableRow key={`${row.host ?? ""} ${row.url}`}>
                      {showHost && (
                        <TableCell className="text-xs text-muted-foreground">
                          {row.host ? (
                            <div className="flex min-w-0 max-w-[220px] items-center gap-1">
                              <span className="min-w-0 truncate" title={row.host}>
                                {row.host}
                              </span>
                              {hostMenu(row.host)}
                            </div>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                      )}
                      <TableCell
                        className="font-mono text-xs max-w-[420px] truncate"
                        title={row.url}
                      >
                        {row.url}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(row.hits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(row.errorHits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBytes(row.totalBytes)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDurationOrNa(row.avgRequestTime)}
                      </TableCell>
                    </TableRow>
                  ),
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
