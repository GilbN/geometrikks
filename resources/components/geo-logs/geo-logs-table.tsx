/**
 * Grouped geo-events table: one row per (location, IP) pair with an event
 * count, server-paginated and server-sorted by any visible column except
 * servers and organization. Page/size/sort state lives in the route's URL
 * search params and arrives here as props; the filter set comes from
 * GeoLogFiltersContext like everything else on the page. Selecting a row
 * opens GeoLogDetailSheet.
 */
import { memo, useMemo, useState } from "react"
import { Columns3 } from "lucide-react"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { useIsMobile } from "@/hooks/use-mobile"
import { sortOptions } from "@/components/data/sort-options"
import { SortableHead } from "@/components/data/sortable-head"
import { TableSortDrawer } from "@/components/data/table-sort-drawer"
import { formatRowTime } from "@/lib/row-time"
import { VirtualTable, VirtualTableBody } from "@/components/data/virtual-table"
import { useTimeRange } from "@/lib/time-range-context"
import { useGeoLogFilters } from "@/lib/geo-log-filters-context"
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
import { rowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import {
  GEO_LOG_COLUMNS,
  GEO_LOG_RENAMED_COLUMN_KEYS,
  type GeoLogColumn,
} from "@/components/geo-logs/columns"
import { GeoLogDetailSheet } from "@/components/geo-logs/geo-log-detail-sheet"
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber, type GeoLogSortField, type GeoLogSortOrder } from "@/lib/api"
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { geoLogFilterTargets } from "@/lib/ip-filter-targets"
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
      return <CountryLabel code={r.countryCode} name={r.countryName}>{r.countryCode}</CountryLabel>
    case "countryName":
      return <span className="whitespace-nowrap">{r.countryName}</span>
    case "ipAddress":
      return <IpLabel ip={r.ipAddress} />
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
    case "servers":
      return (
        <span className="block truncate font-mono" title={r.servers.join(", ") || undefined}>
          {r.servers.length ? r.servers.join(", ") : "-"}
        </span>
      )
    case "asn":
      return <span className="font-mono text-xs">{r.asn != null ? `AS${r.asn}` : "-"}</span>
    case "asOrganization":
      return (
        <span className="block max-w-[240px] truncate" title={r.asOrganization ?? undefined}>
          {r.asOrganization ?? "-"}
        </span>
      )
  }
}

const getRowKey = (row: GeoLogEntry) => `${row.locationId}-${row.ipAddress}`

const SORT_OPTIONS = sortOptions(GEO_LOG_COLUMNS)

function GeoLogIpActions({ row }: { row: GeoLogEntry }) {
  return (
    <IpActionsMenu
      ip={row.ipAddress}
      locationId={row.locationId}
      countryCode={row.countryCode}
      countryName={row.countryName}
      city={row.city}
      asn={row.asn}
      asOrganization={row.asOrganization}
    />
  )
}

/** A narrow row: where and how much on top, who and when below. */
function GeoLogNarrowCell({ row }: { row: GeoLogEntry }) {
  return (
    <TableCell className="py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <CountryFlag code={row.countryCode} name={row.countryName} />
        <span className="min-w-0 flex-1 truncate">
          {row.city ?? row.countryName ?? "-"}
          {row.city && row.countryName && <span className="text-muted-foreground">, {row.countryName}</span>}
        </span>
        <span className="shrink-0 font-medium tabular-nums">{formatNumber(row.eventCount)}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <IpLabel ip={row.ipAddress} className="truncate" />
          <GeoLogIpActions row={row} />
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
          {row.lastSeen ? formatRowTime(row.lastSeen) : "-"}
        </span>
      </div>
    </TableCell>
  )
}

const GeoLogTableBody = memo(function GeoLogTableBody({
  rows,
  shownColumns,
  narrow,
  onSelect,
}: {
  rows: GeoLogEntry[]
  shownColumns: GeoLogColumn[]
  narrow: boolean
  onSelect: (row: GeoLogEntry) => void
}) {
  return (
    <VirtualTableBody rows={rows} columnCount={narrow ? 1 : shownColumns.length} getRowKey={getRowKey}>
      {(row) => (
        <TableRow
          key={`${row.locationId}-${row.ipAddress}`}
          aria-label={`${row.city ?? row.countryName}, ${row.ipAddress}, ${formatNumber(row.eventCount)} events`}
          {...rowActivation<HTMLTableRowElement>(() => onSelect(row))}
        >
          {narrow ? (
            <GeoLogNarrowCell row={row} />
          ) : (
            shownColumns.map((c) => (
              <TableCell key={c.key} className={cn(c.grow && "max-w-0 truncate", c.align === "right" && "text-right")}>
                {renderCell(c, row)}
                {c.key === "ipAddress" && <GeoLogIpActions row={row} />}
              </TableCell>
            ))
          )}
        </TableRow>
      )}
    </VirtualTableBody>
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
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  const isMobile = useIsMobile()
  const { range, customRange } = useTimeRange()
  const { filters, setFilters } = useGeoLogFilters()
  const filterTargetsFor = useMemo(() => geoLogFilterTargets(filters, setFilters), [filters, setFilters])
  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } =
    useColumnVisibility("geometrikks-columns-geo-logs", GEO_LOG_COLUMNS, GEO_LOG_RENAMED_COLUMN_KEYS)

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
        <Button variant="outline" size="sm" className="h-8">
          <Columns3 className="mr-1 h-3.5 w-3.5" /> Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-auto min-w-44">
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
      <div ref={layoutRef}>
        <DataTableFrame
          title="Geo events by location and IP"
          description="Grouped locations in the selected time range. Select a row for the complete record."
          count={data ? total : undefined}
          stickyHeader={narrow && isMobile}
          tools={
            narrow ? (
              <TableSortDrawer options={SORT_OPTIONS} sortField={sortField} sortOrder={sortOrder} onSortChange={onSortChange} />
            ) : (
              columnsMenu
            )
          }
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
          <VirtualTable narrow={narrow} columns={shownColumns} rowCount={rows.length} resetKey={JSON.stringify([page, pageSize, sortField, sortOrder, filters, range, customRange])}>
            {!narrow && (
              <TableHeader>
                <TableRow>
                  {shownColumns.map((c) => {
                    if (!c.sortField) {
                      return (
                        <TableHead key={c.key} className={cn(c.align === "right" && "text-right")}>
                          {c.label}
                        </TableHead>
                      )
                    }
                    const columnSortField = c.sortField
                    return (
                      <SortableHead
                        key={c.key}
                        label={c.label}
                        active={sortField === columnSortField}
                        sortOrder={sortOrder}
                        alignRight={c.align === "right"}
                        onToggle={() => toggleSort(columnSortField)}
                      />
                    )
                  })}
                </TableRow>
              </TableHeader>
            )}
            <IpFilterTargetsProvider targetsFor={filterTargetsFor}>
              <GeoLogTableBody key={narrow ? "narrow" : "wide"} rows={rows} shownColumns={shownColumns} narrow={narrow} onSelect={setSelected} />
            </IpFilterTargetsProvider>
          </VirtualTable>
        </DataTableFrame>
      </div>

      <GeoLogDetailSheet entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  )
}
