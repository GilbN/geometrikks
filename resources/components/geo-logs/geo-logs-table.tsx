/**
 * Grouped geo-events table: one row per (location, IP) pair with an event
 * count, server-paginated and sorted by count. Page/size/sort state lives in
 * the route's URL search params and arrives here as props; the filter set
 * comes from GeoLogFiltersContext like everything else on the page.
 */
import { useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
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
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber, type GeoLogSortOrder } from "@/lib/api"
import { useGeoLogs } from "@/lib/queries"
import { cn } from "@/lib/utils"

export const GEO_LOGS_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const

interface ColumnDef {
  key: string
  label: string
  defaultVisible: boolean
  align?: "right"
  render: (row: GeoLogEntry) => React.ReactNode
}

const COLUMNS: ColumnDef[] = [
  {
    key: "city",
    label: "City",
    defaultVisible: true,
    render: (r) => <span className="whitespace-nowrap">{r.city ?? "-"}</span>,
  },
  {
    key: "postalCode",
    label: "Postal Code",
    defaultVisible: true,
    render: (r) => <span className="tabular-nums">{r.postalCode ?? "-"}</span>,
  },
  {
    key: "state",
    label: "State",
    defaultVisible: true,
    render: (r) => <span className="whitespace-nowrap">{r.state ?? "-"}</span>,
  },
  {
    key: "countryCode",
    label: "Country Code",
    defaultVisible: true,
    render: (r) => <span>{r.countryCode}</span>,
  },
  {
    key: "countryName",
    label: "Country",
    defaultVisible: true,
    render: (r) => <span className="whitespace-nowrap">{r.countryName}</span>,
  },
  {
    key: "ipAddress",
    label: "IP",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.ipAddress}</span>,
  },
  {
    key: "latitude",
    label: "Lat",
    defaultVisible: true,
    align: "right",
    render: (r) => <span className="tabular-nums">{r.latitude.toFixed(4)}</span>,
  },
  {
    key: "longitude",
    label: "Long",
    defaultVisible: true,
    align: "right",
    render: (r) => <span className="tabular-nums">{r.longitude.toFixed(4)}</span>,
  },
  {
    key: "eventCount",
    label: "Count",
    defaultVisible: true,
    align: "right",
    render: (r) => <span className="font-medium tabular-nums">{formatNumber(r.eventCount)}</span>,
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
  sortOrder,
  onPageChange,
  onPageSizeChange,
  onSortOrderChange,
}: {
  page: number
  pageSize: number
  sortOrder: GeoLogSortOrder
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onSortOrderChange: (sortOrder: GeoLogSortOrder) => void
}) {
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  )
  const shownColumns = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

  const { data, isLoading, isError, isPlaceholderData } = useGeoLogs({
    currentPage: page,
    pageSize,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = shownColumns.length

  function toggleColumn(key: string) {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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
            <Button variant="outline" size="sm" className="h-8">
              <Columns3 className="mr-1 h-3.5 w-3.5" /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="rounded-md border">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {shownColumns.map((c) => (
                <TableHead key={c.key} className={cn(c.align === "right" && "text-right")}>
                  {c.key === "eventCount" ? (
                    <button
                      type="button"
                      onClick={() => onSortOrderChange(sortOrder === "desc" ? "asc" : "desc")}
                      className="inline-flex flex-row-reverse items-center gap-1 text-foreground hover:text-foreground"
                    >
                      {c.label}
                      {sortOrder === "asc" ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </TableHead>
              ))}
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
