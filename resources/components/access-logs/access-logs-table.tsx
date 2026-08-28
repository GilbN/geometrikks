/**
 * Historical access-logs table: server-paginated, newest-first, scoped to the
 * global time range. Sorting and pagination state live on the parent route
 * (URL search params), driven here via props and callbacks; column visibility
 * persists per browser and the selected row is local state. Filter values come from AccessLogFiltersContext
 * (search, IP, host, hostname, source format, status, method, country and
 * city live in access-logs-filter-bar.tsx). Pairs with GET /api/v1/access-logs/.
 */
import { useState } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import { AccessLogDetailSheet } from "@/components/access-logs/access-log-detail-sheet"
import { ACCESS_LOG_COLUMNS, type AccessLogColumn } from "@/components/access-logs/columns"
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
import { useAccessLogs, useCrowdsecLiveUpdates } from "@/lib/queries"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
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

export const ACCESS_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const

function renderCell(column: AccessLogColumn, r: AccessLog): React.ReactNode {
  switch (column.key) {
    case "timestamp":
      return (
        <span className="whitespace-nowrap text-muted-foreground">
          {new Date(r.timestamp).toLocaleString()}
        </span>
      )
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
        <span className="block max-w-[320px] truncate font-mono" title={r.url ?? undefined}>
          {r.url ?? "-"}
        </span>
      )
    case "host":
      return (
        <span className="block max-w-[200px] truncate font-mono" title={r.host ?? undefined}>
          {r.host ?? "-"}
        </span>
      )
    case "ipAddress":
      return (
        <span className="inline-flex items-center gap-1 font-mono">
          {r.ipAddress}
          <InspectIpButton ip={r.ipAddress} />
        </span>
      )
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
        <span className="block max-w-[240px] truncate font-mono" title={r.referrer ?? undefined}>
          {r.referrer ?? "-"}
        </span>
      )
    case "hostname":
      return <span className="font-mono">{r.hostname ?? "-"}</span>
    case "logFormat":
      return <span className="font-mono">{r.logFormat ?? "-"}</span>
    case "userAgent":
      return (
        <span className="block max-w-[280px] truncate font-mono" title={r.userAgent ?? undefined}>
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
          {r.countryCode ?? "-"}
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
        <span className="block max-w-[220px] truncate" title={r.autonomousSystemOrganization ?? undefined}>
          {r.autonomousSystemOrganization ?? "-"}
        </span>
      )
  }
}

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
  const { filters } = useAccessLogFilters()
  useCrowdsecLiveUpdates()
  const [selected, setSelected] = useState<AccessLog | null>(null)

  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } =
    useColumnVisibility("geometrikks-columns-access-logs", ACCESS_LOG_COLUMNS)

  const { data, isLoading, isError, isPlaceholderData } = useAccessLogs({
    currentPage: page,
    pageSize,
    searchString: filters.search || undefined,
    ipAddressIn: filters.ips.length ? filters.ips : undefined,
    ipAddressNotIn: filters.ipsExclude.length ? filters.ipsExclude : undefined,
    methodIn: filters.methods.length ? filters.methods : undefined,
    hostIn: filters.hosts.length ? filters.hosts : undefined,
    hostNotIn: filters.hostsExclude.length ? filters.hostsExclude : undefined,
    hostnameIn: filters.hostnames.length ? filters.hostnames : undefined,
    hostnameNotIn: filters.hostnamesExclude.length ? filters.hostnamesExclude : undefined,
    logFormatIn: filters.logFormats.length ? filters.logFormats : undefined,
    cityIn: filters.cities.length ? filters.cities : undefined,
    countryCodeIn: filters.countryCodes.length ? filters.countryCodes : undefined,
    statusIn: filters.statusCodes.length ? filters.statusCodes : undefined,
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const state = dataState(isLoading, isError, rows.length)

  function toggleSort(field: AccessLogSortField) {
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
        {ACCESS_LOG_COLUMNS.map((c) => (
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
        title="Request history"
        description="Requests captured in the selected time range. Select a row for the complete record."
        count={data ? total : undefined}
        tools={columnsMenu}
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
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                aria-label={`Request ${row.id}, ${row.method ?? ""} ${row.url ?? ""}, HTTP ${row.statusCode}`}
                {...rowActivation<HTMLTableRowElement>(() => setSelected(row))}
              >
                {shownColumns.map((c) => (
                  <TableCell key={c.key} className={cn(c.align === "right" && "text-right")}>
                    {renderCell(c, row)}
                    {c.key === "ipAddress" && (
                      <span {...stopRowActivation}>
                        <IpBanControls ip={row.ipAddress} />
                      </span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableFrame>

      <AccessLogDetailSheet entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  )
}
