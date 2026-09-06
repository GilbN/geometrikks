/**
 * Grouped geo-events table: one row per (location, IP) pair with an event
 * count, server-paginated and server-sorted by any visible column except
 * hostnames. Page/size/sort state lives in the route's URL search params and
 * arrives here as props; the filter set comes from GeoLogFiltersContext like
 * everything else on the page. Selecting a row opens GeoLogDetailSheet.
 */
import { memo, useState } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import { GEO_LOG_COLUMNS, type GeoLogColumn } from "@/components/geo-logs/columns"
import { GeoLogDetailSheet } from "@/components/geo-logs/geo-log-detail-sheet"
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber, type GeoLogSortField, type GeoLogSortOrder } from "@/lib/api"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { useGeoLogs } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { useColumnVisibility } from "@/lib/column-visibility"

export const GEO_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const

function renderCell(column: GeoLogColumn, r: GeoLogEntry): React.ReactNode {
  switch (column.key) {
    case "city":
      return <span className="whitespace-nowrap">{r.city ?? "-"}</span>
    case "postalCode":
      return <span className="tabular-nums">{r.postalCode ?? "-"}</span>
    case "state":
      return <span className="whitespace-nowrap">{r.state ?? "-"}</span>
    case "countryCode":
      return <span>{r.countryCode}</span>
    case "countryName":
      return <span className="whitespace-nowrap">{r.countryName}</span>
    case "ipAddress":
      return <span className="font-mono">{r.ipAddress}</span>
    case "latitude":
      return <span className="tabular-nums">{r.latitude.toFixed(4)}</span>
    case "longitude":
      return <span className="tabular-nums">{r.longitude.toFixed(4)}</span>
    case "eventCount":
      return <span className="font-medium tabular-nums">{formatNumber(r.eventCount)}</span>
    case "lastSeen":
      // Day-floored on ranges over 24h (daily CAGG buckets), exact otherwise.
      return (
        <span className="whitespace-nowrap text-muted-foreground">
          {r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "-"}
        </span>
      )
    case "hostnames":
      return (
        <span className="block max-w-[240px] truncate font-mono" title={r.hostnames.join(", ") || undefined}>
          {r.hostnames.length ? r.hostnames.join(", ") : "-"}
        </span>
      )
  }
}

const GeoLogTableBody = memo(function GeoLogTableBody({
  rows,
  shownColumns,
  onSelect,
}: {
  rows: GeoLogEntry[]
  shownColumns: GeoLogColumn[]
  onSelect: (row: GeoLogEntry) => void
}) {
  return (
    <TableBody>
      {rows.map((row) => (
        <TableRow
          key={`${row.locationId}-${row.ipAddress}`}
          aria-label={`${row.city ?? row.countryName}, ${row.ipAddress}, ${formatNumber(row.eventCount)} events`}
          {...rowActivation<HTMLTableRowElement>(() => onSelect(row))}
        >
          {shownColumns.map((c) => (
            <TableCell key={c.key} className={cn(c.align === "right" && "text-right")}>
              {renderCell(c, row)}
              {c.key === "ipAddress" && (
                <span {...stopRowActivation}>
                  <IpBanControls ip={row.ipAddress}>
                    <InspectIpButton ip={row.ipAddress} className="ml-1" />
                  </IpBanControls>
                </span>
              )}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  )
})

export function GeoLogsTable({
  page,
  pageSize,
  sortField,
  sortOrder,
  onPageChange,
  onPageSizeChange,
  onSortChange,
}: {
  page: number
  pageSize: number
  sortField: GeoLogSortField
  sortOrder: GeoLogSortOrder
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onSortChange: (sortField: GeoLogSortField, sortOrder: GeoLogSortOrder) => void
}) {
  const [selected, setSelected] = useState<GeoLogEntry | null>(null)
  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } =
    useColumnVisibility("geometrikks-columns-geo-logs", GEO_LOG_COLUMNS)

  const { data, isLoading, isError, isPlaceholderData } = useGeoLogs({
    currentPage: page,
    pageSize,
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const state = dataState(isLoading, isError, rows.length)

  function toggleSort(field: GeoLogSortField) {
    if (sortField === field) {
      onSortChange(field, sortOrder === "asc" ? "desc" : "asc")
    } else {
      onSortChange(field, "desc")
    }
  }

  const columnsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 pointer-coarse:h-10">
          <Columns3 className="mr-1 h-3.5 w-3.5" /> Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-auto min-w-44 overflow-y-auto">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {GEO_LOG_COLUMNS.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={visible.has(c.key)}
            onCheckedChange={() => toggleColumn(c.key)}
            onSelect={(e) => e.preventDefault()}
            disabled={visible.has(c.key) && visible.size === 1}
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hasOverrides} onSelect={resetColumns}>
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <DataTableFrame
        title="Geo events by location and IP"
        description="Grouped locations in the selected time range. Select a row for the complete record."
        count={data ? total : undefined}
        tools={columnsMenu}
        state={state}
        error="Failed to load geo logs."
        empty="No geo events match these filters."
        footer={
          <PaginationFooter
            page={page}
            pageCount={pageCount}
            total={total}
            onPageChange={onPageChange}
            disabled={isPlaceholderData}
            pageSize={pageSize}
            pageSizes={GEO_LOGS_PAGE_SIZES}
            onPageSizeChange={onPageSizeChange}
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              {shownColumns.map((c) => {
                const active = c.sortField && sortField === c.sortField
                return (
                  <TableHead key={c.key} className={cn(c.align === "right" && "text-right")}>
                    {c.sortField ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.sortField!)}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          c.align === "right" && "flex-row-reverse",
                          active ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {c.label}
                        {active ? (
                          sortOrder === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      c.label
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <GeoLogTableBody rows={rows} shownColumns={shownColumns} onSelect={setSelected} />
        </Table>
      </DataTableFrame>

      <GeoLogDetailSheet entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  )
}
