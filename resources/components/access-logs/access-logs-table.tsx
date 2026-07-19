/**
 * Historical access-logs table: server-paginated, newest-first, scoped to the
 * global time range. Supports column sorting, text search, and IP / method /
 * domain filters. Pairs with GET /api/v1/access-logs/.
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import {
  ArrowDown,
  ArrowUp,
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
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { useAccessLogs, useAccessLogFacets } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import {
  formatBytes,
  formatDuration,
  type AccessLog,
  type AccessLogSortField,
  type SortOrder,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const

const HTTP_METHODS = [
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE",
] as const
const STATUS_CODES = [
  100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
  300, 301, 302, 303, 304, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426,
  428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
] as const

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
  sortField?: AccessLogSortField
  defaultVisible: boolean
  align?: "right"
  headClassName?: string
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
    render: (r) => <span className="tabular-nums">{formatBytes(r.bytesSent)}</span>,
  },
  {
    key: "requestTime",
    label: "Req time",
    sortField: "requestTime",
    defaultVisible: true,
    align: "right",
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
    render: (r) => (
      <span className="block max-w-[240px] truncate font-mono" title={r.referrer ?? undefined}>
        {r.referrer ?? "-"}
      </span>
    ),
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
    render: (r) => <span className="whitespace-nowrap">{r.city ?? "-"}</span>,
  },
]

/** Full IPv4/IPv6 check — the backend's ip_address column is INET, so a
 * partial value (mid-typing) must not reach the query. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_RE =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:)*:([0-9a-f]{1,4}:)*[0-9a-f]{0,4})$/i

function isValidIp(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(":") && IPV6_RE.test(value))
}

export function AccessLogsTable() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // Filters (raw input; text inputs are debounced before hitting the query).
  const [searchInput, setSearchInput] = useState("")
  const [ipInput, setIpInput] = useState("")
  const [hostInput, setHostInput] = useState("")
  const [methods, setMethods] = useState<string[]>([])
  const [statusCodes, setStatusCodes] = useState<number[]>([])
  const [cities, setCities] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  // Facet values are fetched lazily, on first open of either dropdown.
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })
  const search = useDebouncedValue(searchInput, 300)
  const ip = useDebouncedValue(ipInput, 300)
  const host = useDebouncedValue(hostInput, 300)

  // Sorting.
  const [sortField, setSortField] = useState<AccessLogSortField>("timestamp")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  // Column visibility.
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  )
  const shownColumns = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

  // Any filter/sort/page-size change returns to the first page.
  useEffect(() => {
    setPage(1)
  }, [search, ip, host, methods, statusCodes, cities, countries, sortField, sortOrder, pageSize])

  const { data, isLoading, isError, isPlaceholderData } = useAccessLogs({
    currentPage: page,
    pageSize,
    searchString: search || undefined,
    // Only forward complete IPs — ip_address is INET server-side, so partial
    // text can't match anything (and would fail bind-param encoding).
    ipAddressIn: ip && isValidIp(ip) ? [ip] : undefined,
    methodIn: methods.length ? methods : undefined,
    statusIn: statusCodes.length ? statusCodes : undefined,
    host: host || undefined,
    cityIn: cities.length ? cities : undefined,
    countryCodeIn: countries.length ? countries : undefined,
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = shownColumns.length

  function toggleSort(field: AccessLogSortField) {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  function toggleValue<T>(
    setter: Dispatch<SetStateAction<T[]>>,
    value: NoInfer<T>,
  ) {
    setter((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    )
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
        Failed to load access logs.
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
            placeholder="Search url / referrer / agent…"
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
        <Input
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          placeholder="Host"
          className="h-8 w-44 font-mono text-xs"
        />

        <FilterCombobox
          label="Status"
          options={[...STATUS_CODES]}
          selected={statusCodes}
          onChange={setStatusCodes}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              Method{methods.length > 0 && ` (${methods.length})`}
              <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>HTTP method</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {HTTP_METHODS.map((m) => (
              <DropdownMenuCheckboxItem
                key={m}
                checked={methods.includes(m)}
                onCheckedChange={() => toggleValue(setMethods, m)}
                onSelect={(e) => e.preventDefault()}
              >
                {m}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

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
        <Table className="text-xs">
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
          onPageChange={setPage}
          disabled={isPlaceholderData}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          onPageSizeChange={setPageSize}
          className="border-t"
        />
      </div>
    </div>
  )
}
