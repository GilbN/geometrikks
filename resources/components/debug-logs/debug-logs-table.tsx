/**
 * Debug-lines table: server-paginated, newest-first, scoped to the global
 * time range. Filters: combined raw-line/parse-error search, IP, country,
 * city, malformed tri-state. Clicking a row opens the raw-line detail
 * dialog. Pairs with GET /api/v1/access-log-debug/.
 */
import { useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  Search,
} from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { DebugLogDetailDialog } from "@/components/debug-logs/debug-log-detail-dialog"
import { useAccessLogDebug, useAccessLogFacets } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import type { AccessLogDebugEntry, AccessLogDebugSortField, SortOrder } from "@/lib/api"
import { cn } from "@/lib/utils"

const PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const

type MalformedFilter = "all" | "malformed" | "wellformed"

/** Tailwind classes for the status badge, by response class. */
function statusBadgeClass(code: number): string {
  if (code >= 500) return "bg-red-500/15 text-red-600 dark:text-red-400"
  if (code >= 400) return "bg-amber-500/15 text-amber-600 dark:text-amber-400"
  if (code >= 300) return "bg-sky-500/15 text-sky-600 dark:text-sky-400"
  return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
}

interface ColumnDef {
  key: string
  label: string
  sortField?: AccessLogDebugSortField
  defaultVisible: boolean
  render: (row: AccessLogDebugEntry) => React.ReactNode
}

const COLUMNS: ColumnDef[] = [
  {
    key: "createdAt",
    label: "Captured",
    sortField: "createdAt",
    defaultVisible: true,
    render: (r) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {new Date(r.createdAt).toLocaleString()}
      </span>
    ),
  },
  {
    key: "isMalformed",
    label: "Malformed",
    sortField: "isMalformed",
    defaultVisible: true,
    render: (r) =>
      r.isMalformed ? (
        <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
          Yes
        </Badge>
      ) : (
        <span className="text-muted-foreground">No</span>
      ),
  },
  {
    key: "parseError",
    label: "Parse error",
    sortField: "parseError",
    defaultVisible: true,
    render: (r) => (
      <span className="block max-w-[220px] truncate" title={r.parseError ?? undefined}>
        {r.parseError ?? "-"}
      </span>
    ),
  },
  {
    key: "rawLine",
    label: "Raw line",
    defaultVisible: true,
    render: (r) => (
      <span className="block max-w-[360px] truncate font-mono" title={r.rawLine}>
        {r.rawLine}
      </span>
    ),
  },
  {
    key: "statusCode",
    label: "Status",
    sortField: "statusCode",
    defaultVisible: true,
    render: (r) =>
      r.statusCode != null ? (
        <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(r.statusCode))}>
          {r.statusCode}
        </Badge>
      ) : (
        <span className="text-muted-foreground">-</span>
      ),
  },
  {
    key: "method",
    label: "Method",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.method ?? "-"}</span>,
  },
  {
    key: "ipAddress",
    label: "IP",
    sortField: "ipAddress",
    defaultVisible: true,
    render: (r) => <span className="font-mono">{r.ipAddress ?? "-"}</span>,
  },
  {
    key: "url",
    label: "URL",
    defaultVisible: false,
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
    defaultVisible: false,
    render: (r) => (
      <span className="block max-w-[200px] truncate font-mono" title={r.host ?? undefined}>
        {r.host ?? "-"}
      </span>
    ),
  },
  {
    key: "timestamp",
    label: "Log time",
    sortField: "timestamp",
    defaultVisible: false,
    render: (r) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "-"}
      </span>
    ),
  },
  {
    key: "country",
    label: "Country",
    sortField: "countryCode",
    defaultVisible: false,
    render: (r) => (
      <span className="whitespace-nowrap" title={r.countryName ?? undefined}>
        {r.countryCode ?? "-"}
      </span>
    ),
  },
  {
    key: "city",
    label: "City",
    sortField: "city",
    defaultVisible: false,
    render: (r) => <span className="whitespace-nowrap">{r.city ?? "-"}</span>,
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
]

/** Full IPv4/IPv6 check - the backend's ip_address column is INET, so
 * a partial value (mid-typing) must not reach the query. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_RE =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:)*:([0-9a-f]{1,4}:)*[0-9a-f]{0,4})$/i

function isValidIp(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(":") && IPV6_RE.test(value))
}

export function DebugLogsTable() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // Filters (raw input; text inputs are debounced before hitting the query).
  const [searchInput, setSearchInput] = useState("")
  const [ipInput, setIpInput] = useState("")
  const [cities, setCities] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  const [malformedFilter, setMalformedFilter] = useState<MalformedFilter>("all")
  // Facet values are fetched lazily, on first open of either dropdown.
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })
  const search = useDebouncedValue(searchInput, 300)
  const ip = useDebouncedValue(ipInput, 300)

  // Sorting.
  const [sortField, setSortField] = useState<AccessLogDebugSortField>("createdAt")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  // Column visibility.
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  )
  const shownColumns = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

  // Detail dialog.
  const [selected, setSelected] = useState<AccessLogDebugEntry | null>(null)

  // Any filter/sort/page-size change returns to the first page.
  useEffect(() => {
    setPage(1)
  }, [search, ip, cities, countries, malformedFilter, sortField, sortOrder, pageSize])

  const { data, isLoading, isError, isPlaceholderData } = useAccessLogDebug({
    currentPage: page,
    pageSize,
    searchString: search || undefined,
    // Only forward complete IPs; partial text cannot match an INET column.
    ipAddressIn: ip && isValidIp(ip) ? [ip] : undefined,
    countryCodeIn: countries.length ? countries : undefined,
    cityIn: cities.length ? cities : undefined,
    malformed:
      malformedFilter === "all" ? undefined : malformedFilter === "malformed",
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = shownColumns.length

  function toggleSort(field: AccessLogDebugSortField) {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

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
        Failed to load debug logs.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search raw line / parse error…"
            className="h-8 w-64 pl-7 text-xs"
          />
        </div>
        <Input
          value={ipInput}
          onChange={(e) => setIpInput(e.target.value)}
          placeholder="IP address"
          aria-invalid={ipInput !== "" && !isValidIp(ipInput)}
          className="h-8 w-36 font-mono text-xs"
        />

        <Select
          value={malformedFilter}
          onValueChange={(v) => setMalformedFilter(v as MalformedFilter)}
        >
          <SelectTrigger size="sm" className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All lines</SelectItem>
            <SelectItem value="malformed">Malformed only</SelectItem>
            <SelectItem value="wellformed">Well-formed only</SelectItem>
          </SelectContent>
        </Select>

        <FilterCombobox
          label="Country"
          options={facets?.countries.map((c) => c.code) ?? []}
          selected={countries}
          onChange={setCountries}
          labelFor={(code) => {
            const name = facets?.countries.find((c) => c.code === code)?.name
            return name ? `${name} (${code})` : code
          }}
          loading={!facets}
          emptyText="No geo data"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
        />

        <FilterCombobox
          label="City"
          options={facets?.cities ?? []}
          selected={cities}
          onChange={setCities}
          loading={!facets}
          emptyText="No geo data"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
        />

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
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                {shownColumns.map((c) => {
                  const active = c.sortField && sortField === c.sortField
                  return (
                    <TableHead key={c.key}>
                      {c.sortField ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(c.sortField!)}
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
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
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(row)}
                    >
                      {shownColumns.map((c) => (
                        <TableCell key={c.key}>{c.render(row)}</TableCell>
                      ))}
                    </TableRow>
                  ))}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                    No debug lines match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} rows - page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="whitespace-nowrap">Rows per page</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => setPageSize(Number(v))}
              >
                <SelectTrigger size="sm" className="h-8 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || isPlaceholderData}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount || isPlaceholderData}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <DebugLogDetailDialog
        entry={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  )
}
