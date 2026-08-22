/**
 * Grouped geo-events table: one row per (location, IP) pair with an event
 * count, server-paginated and server-sorted by any visible column except
 * hostnames. Page/size/sort state lives in the route's URL search params and
 * arrives here as props; the filter set comes from GeoLogFiltersContext like
 * everything else on the page.
 */
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
} from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
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
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber, type GeoLogSortField, type GeoLogSortOrder } from "@/lib/api"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { useGeoLogs } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { useColumnVisibility } from "@/lib/column-visibility"

export const GEO_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const

interface ColumnDef {
  key: string
  label: string
  /** Present when the column is server-sortable; absent for hostnames. */
  sortField?: GeoLogSortField
  defaultVisible: boolean
  align?: "right"
  /** Start hidden on mobile viewports (still selectable via the Columns menu). */
  mobileHidden?: boolean
  render: (row: GeoLogEntry) => React.ReactNode
}

const COLUMNS: ColumnDef[] = [
  {
    key: "city",
    label: "City",
    sortField: "city",
    defaultVisible: true,
    render: (r) => <span className="whitespace-nowrap">{r.city ?? "-"}</span>,
  },
  {
    key: "postalCode",
    label: "Postal Code",
    sortField: "postalCode",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => <span className="tabular-nums">{r.postalCode ?? "-"}</span>,
  },
  {
    key: "state",
    label: "State",
    sortField: "state",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => <span className="whitespace-nowrap">{r.state ?? "-"}</span>,
  },
  {
    key: "countryCode",
    label: "Country Code",
    sortField: "countryCode",
    defaultVisible: true,
    mobileHidden: true,
    render: (r) => <span>{r.countryCode}</span>,
  },
  {
    key: "countryName",
    label: "Country",
    sortField: "countryName",
    defaultVisible: true,
    render: (r) => <span className="whitespace-nowrap">{r.countryName}</span>,
  },
  {
    key: "ipAddress",
    label: "IP",
    sortField: "ipAddress",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.ipAddress}</span>,
  },
  {
    key: "latitude",
    label: "Lat",
    sortField: "latitude",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
    render: (r) => <span className="tabular-nums">{r.latitude.toFixed(4)}</span>,
  },
  {
    key: "longitude",
    label: "Long",
    sortField: "longitude",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
    render: (r) => <span className="tabular-nums">{r.longitude.toFixed(4)}</span>,
  },
  {
    key: "eventCount",
    label: "Count",
    sortField: "eventCount",
    defaultVisible: true,
    align: "right",
    render: (r) => <span className="font-medium tabular-nums">{formatNumber(r.eventCount)}</span>,
  },
  {
    key: "lastSeen",
    label: "Last seen",
    sortField: "lastSeen",
    defaultVisible: true,
    mobileHidden: true,
    // Day-floored on ranges over 24h (daily CAGG buckets), exact otherwise.
    render: (r) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "-"}
      </span>
    ),
  },
  {
    key: "hostnames",
    label: "Hostnames",
    defaultVisible: false,
    render: (r) => (
      <span
        className="block max-w-[240px] truncate font-mono"
        title={r.hostnames.join(", ") || undefined}
      >
        {r.hostnames.length ? r.hostnames.join(", ") : "-"}
      </span>
    ),
  },
]

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
  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } =
    useColumnVisibility("geometrikks-columns-geo-logs", COLUMNS)

  const { data, isLoading, isError, isPlaceholderData } = useGeoLogs({
    currentPage: page,
    pageSize,
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = shownColumns.length

  function toggleSort(field: GeoLogSortField) {
    if (sortField === field) {
      onSortChange(field, sortOrder === "asc" ? "desc" : "asc")
    } else {
      onSortChange(field, "desc")
    }
  }

  if (isError) {
    return (
      <div className="rounded-md border p-6 text-sm text-destructive">
        Failed to load geo logs.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Geo Events by Location and IP</h2>
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
      </div>

      <div className="rounded-md border">
        <Table className="text-xs">
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
                  <TableRow key={`${row.locationId}-${row.ipAddress}`}>
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
                  No geo events match these filters.
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
          pageSizes={GEO_LOGS_PAGE_SIZES}
          onPageSizeChange={onPageSizeChange}
          className="border-t"
        />
      </div>
    </div>
  )
}
