/**
 * Top IPs by geo-event count for the geo-logs page, across all locations,
 * with the organization behind each IP.
 */
import { useMemo } from "react"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { dataState } from "@/components/data/types"
import { useFitLayout } from "@/components/data/narrow-layout"
import { RankedNarrowCell, RankedNarrowHeader } from "@/components/data/ranked-narrow"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/api"
import { useGeoLogTopIps } from "@/lib/queries"
import { AsnCell } from "@/components/geo-logs/asn-cell"
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { geoLogFilterTargets } from "@/lib/ip-filter-targets"
import { useGeoLogFilters } from "@/lib/geo-log-filters-context"
import { TablePaginationFooter, usePagedRows } from "@/components/analytics/table-pagination"

export function GeoTopIpsTable() {
  const { data, isError, isLoading } = useGeoLogTopIps({ limit: 10 })
  const { filters, setFilters } = useGeoLogFilters()
  const filterTargetsFor = useMemo(() => geoLogFilterTargets(filters, setFilters), [filters, setFilters])
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  const state = dataState(isLoading, isError, data?.items.length ?? 0)
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(pageItems.map((row) => row.ipAddress).join())

  return (
    <div ref={layoutRef} className="min-w-0">
      <DataTableFrame
        title="Top IPs"
        description="Clients ranked by geo event count."
        count={data?.items.length}
        state={state}
        error="Failed to load top IPs."
        empty="No geo events match these filters."
        footer={
          pagination.total > pagination.pageSize ? (
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
          ) : undefined
        }
      >
        <Table className={narrow ? "table-fixed" : undefined}>
          {narrow ? (
            <RankedNarrowHeader label="IP" valueLabel="Events" />
          ) : (
            <TableHeader>
              <TableRow>
                <TableHead>IP</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead className="text-right">Events</TableHead>
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
                        <IpActionsMenu
                          ip={row.ipAddress}
                          countryCode={row.countryCode}
                          city={row.city}
                          asn={row.asn}
                          asOrganization={row.asOrganization}
                        />
                      </>
                    }
                    value={formatNumber(row.eventCount)}
                    secondary={
                      <>
                        {(row.countryCode || row.city) && (
                          <span className="flex items-center gap-1">
                            <CountryFlag code={row.countryCode} standalone />
                            {[row.countryCode, row.city].filter(Boolean).join(", ")}
                          </span>
                        )}
                          {row.asn != null && (
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 truncate" title={row.asOrganization ?? undefined}>
                              {row.asOrganization ?? "Unknown"}
                            </span>
                            <span className="shrink-0 font-mono">· AS{row.asn}</span>
                          </span>
                        )}
                      </>
                    }
                  />
                </TableRow>
              ) : (
                <TableRow key={row.ipAddress}>
                  <TableCell className="font-mono text-xs">
                    <IpLabel ip={row.ipAddress} />
                    <IpActionsMenu
                      ip={row.ipAddress}
                      countryCode={row.countryCode}
                      city={row.city}
                      asn={row.asn}
                      asOrganization={row.asOrganization}
                    />
                  </TableCell>
                  <TableCell>{row.countryCode ? <CountryLabel code={row.countryCode} /> : "-"}</TableCell>
                  <TableCell>{row.city ?? "-"}</TableCell>
                  <TableCell className="max-w-[220px]">
                    <AsnCell asn={row.asn} organization={row.asOrganization} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </IpFilterTargetsProvider>
        </Table>
      </DataTableFrame>
    </div>
  )
}
