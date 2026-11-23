/**
 * Historical access-logs table: server-paginated, newest-first, scoped to the
 * global time range. Sorting and pagination state live on the parent route
 * (URL search params), driven here via props and callbacks; column visibility
 * persists per browser and the selected row is local state. Filter values come from AccessLogFiltersContext
 * (search, IP, host, server, source format, status, method, country and
 * city live in access-logs-filter-bar.tsx). Pairs with GET /api/v1/access-logs/.
 */
import { memo, useEffect, useMemo, useState } from "react"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { useIsMobile } from "@/hooks/use-mobile"
import { sortOptions } from "@/components/data/sort-options"
import { SortableHead } from "@/components/data/sortable-head"
import { TableSortDrawer } from "@/components/data/table-sort-drawer"
import { VirtualTable, VirtualTableBody } from "@/components/data/virtual-table"
import { useTimeRange } from "@/lib/time-range-context"
import { Badge } from "@/components/ui/badge"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { rowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import { AccessLogDetailSheet } from "@/components/access-logs/access-log-detail-sheet"
import {
  ACCESS_LOG_COLUMNS,
  ACCESS_LOG_RENAMED_COLUMN_KEYS,
  combinedAccessLogColumns,
  type AccessLogColumn,
  type AccessLogCombinedColumn,
} from "@/components/access-logs/columns"
import { CombinedSortHead } from "@/components/data/combined-sort-head"
import { TableViewMenu } from "@/components/data/table-view-menu"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { pageToClamp } from "@/lib/use-muted-page"
import { useAccessLogs, useCrowdsecLiveUpdates } from "@/lib/queries"
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { accessLogFilterTargets } from "@/lib/ip-filter-targets"
import {
  formatBytes,
  formatDuration,
  type AccessLog,
  type AccessLogSortField,
  type SortOrder,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { useColumnVisibility } from "@/lib/column-visibility"
import { useAccessLogFilters } from "@/lib/access-log-filters-context"
import { statusBadgeClass } from "@/lib/status-badge"
import { formatDurationOrNa } from "@/lib/timing"
import { formatRowTime } from "@/lib/row-time"
import { TableTime } from "@/components/data/table-time"
import { useTableView, useTimeFormat, type ColumnLayout, type TimeFormat } from "@/lib/table-view"

export const ACCESS_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const
export const ACCESS_LOGS_TABLE_ID = "access-logs"

function renderCell(
  column: AccessLogColumn,
  r: AccessLog,
  timeFormat: TimeFormat,
): React.ReactNode {
  switch (column.key) {
    case "timestamp":
      return <TableTime value={r.timestamp} format={timeFormat} />
    case "statusCode":
      return (
        <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(r.statusCode))}>
          {r.statusCode}
        </Badge>
      )
    case "method":
      return <span className="font-mono">{r.method ?? "-"}</span>
    case "url":
      return (
        <span className="block truncate font-mono" title={r.url ?? undefined}>
          {r.url ?? "-"}
        </span>
      )
    case "host":
      return (
        <span className="block truncate font-mono" title={r.host ?? undefined}>
          {r.host ?? "-"}
        </span>
      )
    case "ipAddress":
      return <IpLabel ip={r.ipAddress} />
    case "bytesSent":
      return <span className="tabular-nums">{formatBytes(r.bytesSent)}</span>
    case "requestTime":
      return <span className="tabular-nums">{formatDurationOrNa(r.requestTime)}</span>
    case "remoteUser":
      return <span className="font-mono">{r.remoteUser ?? "-"}</span>
    case "httpVersion":
      return <span className="font-mono">{r.httpVersion ?? "-"}</span>
    case "referrer":
      return (
        <span className="block truncate font-mono" title={r.referrer ?? undefined}>
          {r.referrer ?? "-"}
        </span>
      )
    case "server":
      return <span className="font-mono">{r.server ?? "-"}</span>
    case "logFormat":
      return <span className="font-mono">{r.logFormat ?? "-"}</span>
    case "userAgent":
      return (
        <span className="block truncate font-mono" title={r.userAgent ?? undefined}>
          {r.userAgent ?? "-"}
        </span>
      )
    case "upstreamResponseTime":
      return (
        <span className="tabular-nums">
          {r.upstreamResponseTime != null ? formatDuration(r.upstreamResponseTime * 1000) : "-"}
        </span>
      )
    case "country":
      return (
        <span className="whitespace-nowrap" title={r.countryName ?? undefined}>
          {r.countryCode ? (
            <CountryLabel code={r.countryCode} name={r.countryName}>
              {r.countryCode}
            </CountryLabel>
          ) : (
            "-"
          )}
        </span>
      )
    case "city":
      return <span className="whitespace-nowrap">{r.city ?? "-"}</span>
    case "asn":
      return (
        <span className="font-mono">
          {r.autonomousSystemNumber != null ? `AS${r.autonomousSystemNumber}` : "-"}
        </span>
      )
    case "asnOrganization":
      return (
        <span className="block truncate" title={r.autonomousSystemOrganization ?? undefined}>
          {r.autonomousSystemOrganization ?? "-"}
        </span>
      )
  }
}

/** A referrer without its scheme, which every row would repeat. */
function shortReferrer(referrer: string): string {
  return referrer.replace(/^https?:\/\//, "")
}

function renderCombinedCell(
  column: AccessLogCombinedColumn,
  r: AccessLog,
  timeFormat: TimeFormat,
): React.ReactNode {
  const has = (key: string) => column.fields.some((field) => field.key === key)
  switch (column.key) {
    case "request": {
      const target = `${has("host") ? (r.host ?? "") : ""}${has("url") ? (r.url ?? "") : ""}`
      const title = [has("method") ? r.method : null, target].filter(Boolean).join(" ")
      return (
        <span className="flex min-w-0 items-baseline gap-2 font-mono" title={title}>
          {has("method") && (
            <span
              className={cn(
                "min-w-[38px] shrink-0 text-[11px] font-semibold",
                r.method && r.method !== "GET"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {r.method ?? "-"}
            </span>
          )}
          {has("host") && (
            <span className="min-w-0 shrink truncate text-muted-foreground">{r.host ?? "-"}</span>
          )}
          {has("url") && <span className="min-w-[40%] flex-1 truncate">{r.url ?? "-"}</span>}
        </span>
      )
    }
    case "client":
      return (
        <span className="flex items-center gap-1.5">
          <CountryFlag code={r.countryCode} name={r.countryName} standalone />
          <IpLabel ip={r.ipAddress} short />
          <AccessLogIpActions row={r} />
        </span>
      )
    case "location": {
      const place = [has("city") ? r.city : null, has("country") ? r.countryCode : null]
        .filter(Boolean)
        .join(", ")
      return (
        <span className="block truncate text-muted-foreground" title={r.countryName ?? undefined}>
          {place || "-"}
        </span>
      )
    }
    case "referrer":
      return (
        <span
          className="block truncate font-mono text-xs text-muted-foreground"
          title={r.referrer ?? undefined}
        >
          {r.referrer ? shortReferrer(r.referrer) : "-"}
        </span>
      )
    default:
      return renderCell(column.fields[0], r, timeFormat)
  }
}

/** Request sorts by path first, both on a header click and at the top of its field list. */
const SORT_RANK: Partial<Record<AccessLogSortField, number>> = { url: 0, host: 1, method: 2 }
const sortRank = (field: AccessLogSortField) => SORT_RANK[field] ?? 0

const getRowKey = (row: AccessLog) => row.id

const SORT_OPTIONS = sortOptions(ACCESS_LOG_COLUMNS)

function AccessLogIpActions({ row }: { row: AccessLog }) {
  return (
    <IpActionsMenu
      muteToggle
      ip={row.ipAddress}
      host={row.host}
      server={row.server}
      countryCode={row.countryCode}
      countryName={row.countryName}
      city={row.city}
      asn={row.autonomousSystemNumber}
      asOrganization={row.autonomousSystemOrganization}
    />
  )
}

/** A narrow row: what was asked and the answer on top, when and who below. */
function AccessLogNarrowCell({ row, timeFormat }: { row: AccessLog; timeFormat: TimeFormat }) {
  return (
    <TableCell className="py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge
          className={cn(
            "shrink-0 tabular-nums border-transparent",
            statusBadgeClass(row.statusCode),
          )}
        >
          {row.statusCode}
        </Badge>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {row.method ?? "-"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={row.url ?? undefined}>
          {row.url ?? "-"}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {formatRowTime(row.timestamp, { format: timeFormat })}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          <CountryFlag code={row.countryCode} name={row.countryName} standalone />
          <IpLabel ip={row.ipAddress} className="truncate" />
          <AccessLogIpActions row={row} />
        </span>
      </div>
    </TableCell>
  )
}

const AccessLogTableBody = memo(function AccessLogTableBody({
  rows,
  shownColumns,
  combinedColumns,
  layout,
  narrow,
  timeFormat,
  onSelect,
}: {
  rows: AccessLog[]
  shownColumns: AccessLogColumn[]
  combinedColumns: AccessLogCombinedColumn[]
  layout: ColumnLayout
  narrow: boolean
  timeFormat: TimeFormat
  onSelect: (row: AccessLog) => void
}) {
  return (
    <VirtualTableBody
      rows={rows}
      columnCount={
        narrow ? 1 : layout === "combined" ? combinedColumns.length : shownColumns.length
      }
      getRowKey={getRowKey}
    >
      {(row) => (
        <TableRow
          key={row.id}
          aria-label={`Request ${row.id}, ${row.method ?? ""} ${row.url ?? ""}, HTTP ${row.statusCode}`}
          {...rowActivation<HTMLTableRowElement>(() => onSelect(row))}
        >
          {narrow ? (
            <AccessLogNarrowCell row={row} timeFormat={timeFormat} />
          ) : layout === "combined" ? (
            combinedColumns.map((c) => (
              <TableCell
                key={c.key}
                className={cn(
                  (c.grow || c.width) && "max-w-0 truncate",
                  c.align === "right" && "text-right",
                )}
                style={c.minWidth ? { minWidth: c.minWidth } : undefined}
              >
                {renderCombinedCell(c, row, timeFormat)}
              </TableCell>
            ))
          ) : (
            shownColumns.map((c) => (
              <TableCell
                key={c.key}
                className={cn(c.grow && "max-w-0 truncate", c.align === "right" && "text-right")}
              >
                {renderCell(c, row, timeFormat)}
                {c.key === "ipAddress" && <AccessLogIpActions row={row} />}
              </TableCell>
            ))
          )}
        </TableRow>
      )}
    </VirtualTableBody>
  )
})

interface AccessLogsTableProps {
  page: number
  pageSize: number
  sortField: AccessLogSortField
  sortOrder: SortOrder
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  onSortChange: (field: AccessLogSortField, order: SortOrder) => void
}

export function AccessLogsTable({
  page,
  pageSize,
  sortField,
  sortOrder,
  onPageChange,
  onPageSizeChange,
  onSortChange,
}: AccessLogsTableProps) {
  const { filters, setFilters, muted } = useAccessLogFilters()
  const filterTargetsFor = useMemo(
    () => accessLogFilterTargets(filters, setFilters),
    [filters, setFilters],
  )
  const { range, customRange } = useTimeRange()
  useCrowdsecLiveUpdates()
  const [selected, setSelected] = useState<AccessLog | null>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  const isMobile = useIsMobile()

  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } = useColumnVisibility(
    "geometrikks-columns-access-logs",
    ACCESS_LOG_COLUMNS,
    ACCESS_LOG_RENAMED_COLUMN_KEYS,
  )
  const { density, layout, setDensity, setLayout, resetView, hasViewOverrides } =
    useTableView(ACCESS_LOGS_TABLE_ID)
  const [timeFormat] = useTimeFormat()
  const combinedColumns = useMemo(() => combinedAccessLogColumns(shownColumns), [shownColumns])

  const { data, isLoading, isError, isPlaceholderData } = useAccessLogs({
    currentPage: page,
    pageSize,
    searchString: filters.search || undefined,
    ipAddressIn: filters.ips.length ? filters.ips : undefined,
    ipAddressNotIn: filters.ipsExclude.length ? filters.ipsExclude : undefined,
    methodIn: filters.methods.length ? filters.methods : undefined,
    hostIn: filters.hosts.length ? filters.hosts : undefined,
    hostNotIn: filters.hostsExclude.length ? filters.hostsExclude : undefined,
    serverIn: filters.servers.length ? filters.servers : undefined,
    serverNotIn: filters.serversExclude.length ? filters.serversExclude : undefined,
    logFormatIn: filters.logFormats.length ? filters.logFormats : undefined,
    asnIn: filters.asns.length ? filters.asns : undefined,
    asnNotIn: filters.asnsExclude.length ? filters.asnsExclude : undefined,
    cityIn: filters.cities.length ? filters.cities : undefined,
    countryCodeIn: filters.countryCodes.length ? filters.countryCodes : undefined,
    statusIn: filters.statusCodes.length ? filters.statusCodes : undefined,
    sortField,
    sortOrder,
    muted,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    const target = pageToClamp({ loaded: !!data, placeholder: isPlaceholderData, page, pageCount })
    if (target !== null) onPageChange(target)
  }, [data, isPlaceholderData, page, pageCount, onPageChange])

  // A changed hidden set can leave the open row off the list.
  useEffect(() => {
    setSelected(null)
  }, [muted.flag, muted.version])
  const state = dataState(isLoading, isError, rows.length)

  function toggleSort(field: AccessLogSortField) {
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
      fields={ACCESS_LOG_COLUMNS}
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
    const options = sortOptions(c.fields)
      .map((option) => (option.field === "url" ? { ...option, label: "Path" } : option))
      .sort((a, b) => sortRank(a.field) - sortRank(b.field))
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
          title="Request history"
          description="Requests captured in the selected time range. Select a row for the complete record."
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
          error="Failed to load access logs."
          empty="No access logs match these filters."
          footer={
            <PaginationFooter
              page={page}
              pageCount={pageCount}
              total={total}
              onPageChange={onPageChange}
              disabled={isPlaceholderData}
              pageSize={pageSize}
              pageSizes={ACCESS_LOGS_PAGE_SIZES}
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
            <AccessLogTableBody
              key={narrow ? "narrow" : "wide"}
              rows={rows}
              shownColumns={shownColumns}
              combinedColumns={combinedColumns}
              layout={layout}
              narrow={narrow}
              timeFormat={timeFormat}
              onSelect={setSelected}
            />
          </VirtualTable>
        </DataTableFrame>
      </div>

      <AccessLogDetailSheet entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </IpFilterTargetsProvider>
  )
}
