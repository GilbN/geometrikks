/**
 * Historical access-logs table: server-paginated, newest-first, scoped to the
 * global time range. Sorting and pagination state live on the parent route
 * (URL search params), driven here via props and callbacks; only column
 * visibility is local state. Filter values come from AccessLogFiltersContext
 * (search, IP, host, hostname, source format, status, method, country and
 * city live in access-logs-filter-bar.tsx). Pairs with GET /api/v1/access-logs/.
 */
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
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
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
import { ErrorBanner } from "@/components/error-banner"
import { useAccessLogs, useCrowdsecLiveUpdates } from "@/lib/queries"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
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

export const ACCESS_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const

interface ColumnDef {
  key: string
  label: string
  sortField?: AccessLogSortField
  defaultVisible: boolean
  align?: "right"
  headClassName?: string
  /** Start hidden on mobile viewports (still selectable via the Columns menu). */
  mobileHidden?: boolean
  render: (row: AccessLog) => React.ReactNode
}

const COLUMNS: ColumnDef[] = [
  {
    key: "timestamp",
    label: "Time",
    sortField: "timestamp",
    defaultVisible: true,
    render: (r) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {new Date(r.timestamp).toLocaleString()}
      </span>
    ),
  },
  {
    key: "statusCode",
    label: "Status",
    sortField: "statusCode",
    defaultVisible: true,
    render: (r) => (
      <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(r.statusCode))}>
        {r.statusCode}
      </Badge>
    ),
  },
  {
    key: "method",
    label: "Method",
    sortField: "method",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.method ?? "-"}</span>,
  },
  {
    key: "url",
    label: "URL",
    sortField: "url",
    defaultVisible: true,
    render: (r) => (
      <span className="block max-w-[320px] truncate font-mono" title={r.url ?? undefined}>
        {r.url ?? "-"}
      </span>
    ),
  },
  {
    key: "host",
    label: "Host",
    sortField: "host",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => (
      <span className="block max-w-[200px] truncate font-mono" title={r.host ?? undefined}>
        {r.host ?? "-"}
      </span>
    ),
  },
  {
    key: "ipAddress",
    label: "IP",
    sortField: "ipAddress",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.ipAddress}</span>,
  },
  {
    key: "bytesSent",
    label: "Bytes",
    sortField: "bytesSent",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
    render: (r) => <span className="tabular-nums">{formatBytes(r.bytesSent)}</span>,
  },
  {
    key: "requestTime",
    label: "Req time",
    sortField: "requestTime",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
    render: (r) => <span className="tabular-nums">{formatDuration(r.requestTime * 1000)}</span>,
  },
  {
    key: "remoteUser",
    label: "Remote user",
    defaultVisible: false,
    render: (r) => <span className="font-mono">{r.remoteUser ?? "-"}</span>,
  },
  {
    key: "httpVersion",
    label: "HTTP ver",
    defaultVisible: false,
    render: (r) => <span className="font-mono">{r.httpVersion ?? "-"}</span>,
  },
  {
    key: "referrer",
    label: "Referrer",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => (
      <span className="block max-w-[240px] truncate font-mono" title={r.referrer ?? undefined}>
        {r.referrer ?? "-"}
      </span>
    ),
  },
  {
    key: "hostname",
    label: "Recorded by",
    defaultVisible: false,
    mobileHidden: true,
    render: (r) => <span className="font-mono">{r.hostname ?? "-"}</span>,
  },
  {
    key: "logFormat",
    label: "Source format",
    defaultVisible: false,
    mobileHidden: true,
    render: (r) => <span className="font-mono">{r.logFormat ?? "-"}</span>,
  },
  {
    key: "userAgent",
    label: "User agent",
    defaultVisible: false,
    render: (r) => (
      <span className="block max-w-[280px] truncate font-mono" title={r.userAgent ?? undefined}>
        {r.userAgent ?? "-"}
      </span>
    ),
  },
  {
    key: "upstreamResponseTime",
    label: "Upstream res time",
    defaultVisible: false,
    align: "right",
    render: (r) => (
      <span className="tabular-nums">
        {r.upstreamResponseTime != null ? formatDuration(r.upstreamResponseTime * 1000) : "-"}
      </span>
    ),
  },
  {
    key: "country",
    label: "Country",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => (
      <span className="whitespace-nowrap" title={r.countryName ?? undefined}>
        {r.countryCode ?? "-"}
      </span>
    ),
  },
  {
    key: "city",
    label: "City",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => <span className="whitespace-nowrap">{r.city ?? "-"}</span>,
  },
  {
    key: "asn",
    label: "ASN",
    defaultVisible: false,
    mobileHidden: true,
    render: (r) => (
      <span className="font-mono">
        {r.autonomousSystemNumber != null ? `AS${r.autonomousSystemNumber}` : "-"}
      </span>
    ),
  },
  {
    key: "asnOrganization",
    label: "AS organization",
    defaultVisible: false,
    mobileHidden: true,
    render: (r) => (
      <span
        className="block max-w-[220px] truncate"
        title={r.autonomousSystemOrganization ?? undefined}
      >
        {r.autonomousSystemOrganization ?? "-"}
      </span>
    ),
  },
]

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

  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } =
    useColumnVisibility("geometrikks-columns-access-logs", COLUMNS)

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
  const colCount = shownColumns.length

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
        {COLUMNS.map((c) => (
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

  if (isError) {
    return <ErrorBanner title="Failed to load access logs." />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">{columnsMenu}</div>

      <Card className="gap-0 py-0">
        <Table>
          <TableHeader>
            <TableRow>
              {shownColumns.map((c) => {
                const active = c.sortField && sortField === c.sortField
                return (
                  <TableHead
                    key={c.key}
                    className={cn(c.align === "right" && "text-right", c.headClassName)}
                  >
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
            {isLoading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {shownColumns.map((c) => (
                      <TableCell key={c.key}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row) => (
                  <TableRow key={row.id}>
                    {shownColumns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(c.align === "right" && "text-right")}
                      >
                        {c.render(row)}
                        {c.key === "ipAddress" && <IpBanControls ip={row.ipAddress} />}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                  No access logs match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <PaginationFooter
          page={page}
          pageCount={pageCount}
          total={total}
          onPageChange={onPageChange}
          disabled={isPlaceholderData}
          pageSize={pageSize}
          pageSizes={ACCESS_LOGS_PAGE_SIZES}
          onPageSizeChange={onPageSizeChange}
          className="border-t"
        />
      </Card>
    </div>
  )
}
