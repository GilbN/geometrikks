/**
 * Grouped geo-events table: one row per (location, IP) pair with an event
 * count, server-paginated and server-sorted by any visible column except
 * servers and organization. Page/size/sort state lives in the route's URL
 * search params and arrives here as props; the filter set comes from
 * GeoLogFiltersContext like everything else on the page. Selecting a row
 * opens GeoLogDetailSheet.
 */
import { memo, useCallback, useEffect, useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { useIsMobile } from "@/hooks/use-mobile"
import { sortOptions } from "@/components/data/sort-options"
import { SortableHead } from "@/components/data/sortable-head"
import { CombinedSortHead } from "@/components/data/combined-sort-head"
import { TableSortDrawer } from "@/components/data/table-sort-drawer"
import { formatRowTime } from "@/lib/row-time"
import { VirtualTable, VirtualTableBody } from "@/components/data/virtual-table"
import { useTimeRange } from "@/lib/time-range-context"
import { useGeoLogFilters } from "@/lib/geo-log-filters-context"
import { TableTime } from "@/components/data/table-time"
import { TableViewMenu } from "@/components/data/table-view-menu"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { rowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import {
  GEO_LOG_COLUMNS,
  GEO_LOG_RENAMED_COLUMN_KEYS,
  combinedGeoLogColumns,
  type GeoLogColumn,
  type GeoLogCombinedColumn,
} from "@/components/geo-logs/columns"
import { GeoLogDetailSheet } from "@/components/geo-logs/geo-log-detail-sheet"
import { recordStatus } from "@/components/data/detail-sheet"
import { useRecordLink } from "@/hooks/use-record-link"
import { geoRecord, parseGeoRecord } from "@/lib/record-search"
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber, type GeoLogSortField, type GeoLogSortOrder } from "@/lib/api"
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { geoLogFilterTargets, type IpRowValues } from "@/lib/ip-filter-targets"
import { queryKeys, useGeoLogRecord, useGeoLogs } from "@/lib/queries"
import { pageToClamp } from "@/lib/use-muted-page"
import { cn } from "@/lib/utils"
import { useColumnVisibility } from "@/lib/column-visibility"
import { useTableView, useTimeFormat, type ColumnLayout, type TimeFormat } from "@/lib/table-view"

export const GEO_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const
export const GEO_LOGS_TABLE_ID = "geo-logs"

function renderCell(column: GeoLogColumn, r: GeoLogEntry, timeFormat: TimeFormat): React.ReactNode {
  switch (column.key) {
    case "city":
      return <span className="whitespace-nowrap">{r.city ?? "-"}</span>
    case "postalCode":
      return <span className="tabular-nums">{r.postalCode ?? "-"}</span>
    case "state":
      return <span className="whitespace-nowrap">{r.state ?? "-"}</span>
    case "countryCode":
      return (
        <CountryLabel code={r.countryCode} name={r.countryName}>
          {r.countryCode}
        </CountryLabel>
      )
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
      return r.lastSeen ? (
        <TableTime value={r.lastSeen} format={timeFormat} />
      ) : (
        <span className="text-muted-foreground">-</span>
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

function renderCombinedCell(
  column: GeoLogCombinedColumn,
  r: GeoLogEntry,
  timeFormat: TimeFormat,
): React.ReactNode {
  const has = (key: string) => column.fields.some((field) => field.key === key)
  switch (column.key) {
    case "location": {
      const city = has("city") ? r.city : null
      const state = has("state") ? r.state : null
      const place = [city, state].filter(Boolean).join(", ")
      // The flag follows Country Code, as in Separate; Country owns the full name.
      const showFlag = has("countryCode")
      const country = has("countryName")
        ? r.countryName || (showFlag ? r.countryCode : null)
        : showFlag
          ? r.countryCode
          : null
      const postal = has("postalCode") ? r.postalCode : null
      if (!place && !country && !postal) return <span className="text-muted-foreground">-</span>
      const title = [[place, country].filter(Boolean).join(" · "), postal].filter(Boolean).join(" ")
      return (
        <span className="flex min-w-0 items-center gap-2" title={title || undefined}>
          {showFlag && <CountryFlag code={r.countryCode} name={r.countryName} />}
          {(place || country) && (
            <span className="min-w-0 truncate">
              {place ? (
                <>
                  {place}
                  {country && <span className="text-muted-foreground"> · {country}</span>}
                </>
              ) : (
                country
              )}
            </span>
          )}
          {postal && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{postal}</span>
          )}
        </span>
      )
    }
    case "client":
      return (
        <span className="flex items-center gap-1.5">
          <IpLabel ip={r.ipAddress} short />
          <GeoLogIpActions row={r} />
        </span>
      )
    case "coordinates": {
      const parts = [
        has("latitude") ? r.latitude.toFixed(4) : null,
        has("longitude") ? r.longitude.toFixed(4) : null,
      ].filter(Boolean)
      return (
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">
          {parts.join(", ")}
        </span>
      )
    }
    default:
      return renderCell(column.fields[0], r, timeFormat)
  }
}

const COMBINED_SORT_LABELS: Partial<Record<GeoLogSortField, string>> = {
  postalCode: "Postal code",
  countryCode: "Country code",
  latitude: "Latitude",
  longitude: "Longitude",
}

const getRowKey = (row: GeoLogEntry) => `${row.locationId}-${row.ipAddress}`

const shortcutValues = (row: GeoLogEntry): IpRowValues => ({
  ip: row.ipAddress,
  countryCode: row.countryCode,
  countryName: row.countryName,
  city: row.city,
  asn: row.asn,
  asOrganization: row.asOrganization,
})

/** The filter F applies on a column, when the page filters on its field. */
const FILTER_NOUNS: Partial<Record<GeoLogColumn["key"], string>> = {
  ipAddress: "IP",
  countryCode: "country",
  countryName: "country",
  asn: "ASN",
  asOrganization: "ASN",
}

/** A combined column filters on the field its header sorts by. */
function combinedFilterNoun(column: GeoLogCombinedColumn): string | undefined {
  const main = column.fields.find((field) => field.sortField) ?? column.fields[0]
  return main ? FILTER_NOUNS[main.key] : undefined
}

const SORT_OPTIONS = sortOptions(GEO_LOG_COLUMNS)

function GeoLogIpActions({ row }: { row: GeoLogEntry }) {
  return (
    <IpActionsMenu
      muteToggle
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
function GeoLogNarrowCell({ row, timeFormat }: { row: GeoLogEntry; timeFormat: TimeFormat }) {
  return (
    <TableCell className="py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <CountryFlag code={row.countryCode} name={row.countryName} />
        <span className="min-w-0 flex-1 truncate">
          {row.city ?? row.countryName ?? "-"}
          {row.city && row.countryName && (
            <span className="text-muted-foreground">, {row.countryName}</span>
          )}
        </span>
        <span className="shrink-0 font-medium tabular-nums">{formatNumber(row.eventCount)}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <IpLabel ip={row.ipAddress} className="truncate" />
          <GeoLogIpActions row={row} />
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
          {row.lastSeen ? formatRowTime(row.lastSeen, { format: timeFormat }) : "-"}
        </span>
      </div>
    </TableCell>
  )
}

const GeoLogTableBody = memo(function GeoLogTableBody({
  rows,
  shownColumns,
  combinedColumns,
  layout,
  narrow,
  timeFormat,
  onSelect,
}: {
  rows: GeoLogEntry[]
  shownColumns: GeoLogColumn[]
  combinedColumns: GeoLogCombinedColumn[]
  layout: ColumnLayout
  narrow: boolean
  timeFormat: TimeFormat
  onSelect: (row: GeoLogEntry) => void
}) {
  return (
    <VirtualTableBody
      rows={rows}
      columnCount={
        narrow ? 1 : layout === "combined" ? combinedColumns.length : shownColumns.length
      }
      getRowKey={getRowKey}
      shortcutValues={shortcutValues}
    >
      {(row) => (
        <TableRow
          key={`${row.locationId}-${row.ipAddress}`}
          aria-label={`${row.city ?? row.countryName}, ${row.ipAddress}, ${formatNumber(row.eventCount)} events`}
          {...rowActivation<HTMLTableRowElement>(() => onSelect(row))}
        >
          {narrow ? (
            <GeoLogNarrowCell row={row} timeFormat={timeFormat} />
          ) : layout === "combined" ? (
            combinedColumns.map((c) => (
              <TableCell
                key={c.key}
                data-filter-noun={combinedFilterNoun(c)}
                className={cn(c.grow && "max-w-0 truncate", c.align === "right" && "text-right")}
                style={c.minWidth ? { minWidth: c.minWidth } : undefined}
              >
                {renderCombinedCell(c, row, timeFormat)}
              </TableCell>
            ))
          ) : (
            shownColumns.map((c) => (
              <TableCell
                key={c.key}
                data-filter-noun={FILTER_NOUNS[c.key]}
                className={cn(c.grow && "max-w-0 truncate", c.align === "right" && "text-right")}
              >
                {renderCell(c, row, timeFormat)}
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
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  const isMobile = useIsMobile()
  const { range, customRange } = useTimeRange()
  const { filters, setFilters, muted } = useGeoLogFilters()
  const filterTargetsFor = useMemo(
    () => geoLogFilterTargets(filters, setFilters),
    [filters, setFilters],
  )
  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } = useColumnVisibility(
    "geometrikks-columns-geo-logs",
    GEO_LOG_COLUMNS,
    GEO_LOG_RENAMED_COLUMN_KEYS,
  )
  const { density, layout, setDensity, setLayout, resetView, hasViewOverrides } =
    useTableView(GEO_LOGS_TABLE_ID)
  const [timeFormat] = useTimeFormat()
  const combinedColumns = useMemo(() => combinedGeoLogColumns(shownColumns), [shownColumns])

  const { data, isLoading, isError, isPlaceholderData } = useGeoLogs({
    currentPage: page,
    pageSize,
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const queryClient = useQueryClient()
  const recordLink = useRecordLink()
  const recordKey = useMemo(() => parseGeoRecord(recordLink.search), [recordLink.search])
  const recordQuery = useGeoLogRecord(recordKey, filters)
  const countedWindow = data?.window
  const openRecord = useCallback(
    (entry: GeoLogEntry) => {
      // Rows from the previous filters stay on screen until the new ones load,
      // and their counts would not match the link.
      if (!countedWindow || isPlaceholderData) return
      const key = { locationId: entry.locationId, ip: entry.ipAddress, ...countedWindow }
      queryClient.setQueryData(queryKeys.records.geoLog(key, filters), entry)
      recordLink.open(geoRecord(key))
    },
    [queryClient, recordLink, countedWindow, isPlaceholderData, filters],
  )

  useEffect(() => {
    const target = pageToClamp({ loaded: !!data, placeholder: isPlaceholderData, page, pageCount })
    if (target !== null) onPageChange(target)
  }, [data, isPlaceholderData, page, pageCount, onPageChange])

  const state = dataState(isLoading, isError, rows.length)

  function toggleSort(field: GeoLogSortField) {
    if (sortField === field) {
      onSortChange(field, sortOrder === "asc" ? "desc" : "asc")
    } else {
      onSortChange(field, "desc")
    }
  }

  const viewMenu = (
    <TableViewMenu
      density={density}
      onDensityChange={setDensity}
      layout={layout}
      onLayoutChange={setLayout}
      layoutHint="Location, Client, Coordinates"
      fields={GEO_LOG_COLUMNS}
      visible={visible}
      onToggleField={toggleColumn}
      canReset={hasOverrides || hasViewOverrides}
      onReset={() => {
        resetColumns()
        resetView()
      }}
    />
  )

  const separateHeader = shownColumns.map((c) => {
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
  })

  const combinedHeader = combinedColumns.map((c) => {
    const options = sortOptions(c.fields).map((option) => ({
      ...option,
      label: COMBINED_SORT_LABELS[option.field] ?? option.label,
    }))
    if (options.length > 1) {
      return (
        <CombinedSortHead
          key={c.key}
          label={c.label}
          options={options}
          sortField={sortField}
          sortOrder={sortOrder}
          onSortChange={onSortChange}
        />
      )
    }
    if (options.length === 1) {
      const columnSortField = options[0].field
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
    }
    return (
      <TableHead key={c.key} className={cn(c.align === "right" && "text-right")}>
        {c.label}
      </TableHead>
    )
  })

  return (
    <IpFilterTargetsProvider targetsFor={filterTargetsFor}>
      {/* Around the sheet too, so its IP actions menu gets the page's filters. */}
      <div ref={layoutRef}>
        <DataTableFrame
          title="Geo events by location and IP"
          description="Grouped locations in the selected time range. Select a row for the complete record."
          count={data ? total : undefined}
          stickyHeader={narrow && isMobile}
          tools={
            narrow ? (
              <TableSortDrawer
                options={SORT_OPTIONS}
                sortField={sortField}
                sortOrder={sortOrder}
                onSortChange={onSortChange}
              />
            ) : (
              viewMenu
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
          <VirtualTable
            narrow={narrow}
            density={density}
            columns={layout === "combined" ? combinedColumns : shownColumns}
            rowCount={rows.length}
            resetKey={JSON.stringify([
              page,
              pageSize,
              sortField,
              sortOrder,
              filters,
              range,
              customRange,
              muted.flag,
              muted.version,
            ])}
          >
            {!narrow && (
              <TableHeader>
                <TableRow>{layout === "combined" ? combinedHeader : separateHeader}</TableRow>
              </TableHeader>
            )}
            <GeoLogTableBody
              key={narrow ? "narrow" : "wide"}
              rows={rows}
              shownColumns={shownColumns}
              combinedColumns={combinedColumns}
              layout={layout}
              narrow={narrow}
              timeFormat={timeFormat}
              onSelect={openRecord}
            />
          </VirtualTable>
        </DataTableFrame>
      </div>

      <GeoLogDetailSheet
        open={recordKey !== null}
        entry={recordQuery.data ?? null}
        status={recordStatus(recordQuery)}
        onOpenChange={(open) => !open && recordLink.close()}
      />
    </IpFilterTargetsProvider>
  )
}
