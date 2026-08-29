/**
 * Top IPs by geo-event count for the geo-logs page, across all locations.
 */
import { DataTableFrame } from "@/components/data/data-table-frame"
import { dataState } from "@/components/data/types"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/api"
import { useGeoLogTopIps } from "@/lib/queries"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { TablePaginationFooter, usePagedRows } from "@/components/analytics/table-pagination"

export function GeoTopIpsTable() {
  const { data, isError, isLoading } = useGeoLogTopIps({ limit: 10 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  const state = dataState(isLoading, isError, data?.items.length ?? 0)

  return (
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
              <TableCell className="font-mono text-xs">
                {row.ipAddress}
                <IpBanControls ip={row.ipAddress}>
                  <InspectIpButton ip={row.ipAddress} className="ml-1" />
                </IpBanControls>
              </TableCell>
              <TableCell>{row.countryCode ?? "-"}</TableCell>
              <TableCell>{row.city ?? "-"}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}
