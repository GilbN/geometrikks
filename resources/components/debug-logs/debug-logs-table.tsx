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
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer, FilterSection } from "@/components/ui/filters-drawer"
import { DebugLogDetailDialog } from "@/components/debug-logs/debug-log-detail-dialog"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { useAccessLogDebug, useAccessLogFacets, useCrowdsecLiveUpdates } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { isValidIp } from "@/lib/crowdsec"
import { useIsMobile } from "@/hooks/use-mobile"
import type { AccessLogDebugEntry, AccessLogDebugSortField, SortOrder } from "@/lib/api"
import { cn, isMobileViewport } from "@/lib/utils"

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
  /** Start hidden on mobile viewports (still selectable via the Columns menu). */
  mobileHidden?: boolean
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
    mobileHidden: true,
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
    mobileHidden: true,
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
    mobileHidden: true,
    render: (r) => <span className="font-mono">{r.method ?? "-"}</span>,
  },
  {
    key: "ipAddress",
    label: "IP",
    sortField: "ipAddress",
    defaultVisible: true,
    mobileHidden: true,
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

export function DebugLogsTable() {
  const isMobile = useIsMobile()
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
  const [visible, setVisible] = useState<Set<string>>(() => {
    const mobile = isMobileViewport()
    return new Set(
      COLUMNS.filter((c) => c.defaultVisible && !(mobile && c.mobileHidden)).map((c) => c.key),
    )
  })
  const shownColumns = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

  // Detail dialog.
  const [selected, setSelected] = useState<AccessLogDebugEntry | null>(null)

  // Keep banned badges in sync with external cscli/console decisions.
  useCrowdsecLiveUpdates()

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

  const activeFilterCount =
    (search ? 1 : 0) +
    (ip ? 1 : 0) +
    (malformedFilter !== "all" ? 1 : 0) +
    (countries.length ? 1 : 0) +
    (cities.length ? 1 : 0)

  function renderFilters(inDrawer: boolean) {
    const wrap = (label: string, node: React.ReactNode) =>
      inDrawer ? <FilterSection label={label}>{node}</FilterSection> : node
    return (
      <>
        {wrap(
          "Search",
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search raw line / parse error…"
              className={cn("h-8 pl-7 text-xs", inDrawer ? "w-full" : "w-64")}
            />
          </div>,
        )}
        {wrap(
          "IP address",
          <Input
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            placeholder="IP address"
            aria-invalid={ipInput !== "" && !isValidIp(ipInput)}
            className={cn("h-8 font-mono text-xs", inDrawer ? "w-full" : "w-36")}
          />,
        )}
        {wrap(
          "Malformed",
          <Select
            value={malformedFilter}
            onValueChange={(v) => setMalformedFilter(v as MalformedFilter)}
          >
            <SelectTrigger size="sm" className={cn("h-8 text-xs pointer-coarse:h-10", inDrawer ? "w-full" : "w-40")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All lines</SelectItem>
              <SelectItem value="malformed">Malformed only</SelectItem>
              <SelectItem value="wellformed">Well-formed only</SelectItem>
            </SelectContent>
          </Select>,
        )}
        {wrap(
          "Country",
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
            forceInline={inDrawer}
          />,
        )}
        {wrap(
          "City",
          <FilterCombobox
            label="City"
            options={facets?.cities ?? []}
            selected={cities}
            onChange={setCities}
            loading={!facets}
            emptyText="No geo data"
            onOpenChange={(open) => open && setFacetsEnabled(true)}
            forceInline={inDrawer}
          />,
        )}
      </>
    )
  }

  const columnsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 pointer-coarse:h-10">
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
  )

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
      {isMobile ? (
        <div className="flex items-center gap-2">
          <div onClick={() => setFacetsEnabled(true)}>
            <FiltersDrawer activeCount={activeFilterCount}>{renderFilters(true)}</FiltersDrawer>
          </div>
          {columnsMenu}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {renderFilters(false)}
          {columnsMenu}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
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
                      <TableCell key={c.key}>
                        {c.render(row)}
                        {c.key === "ipAddress" && row.ipAddress && (
                          // Rows open the detail dialog on click; keep the
                          // ban/unban dropdown from also triggering it.
                          <span onClick={(e) => e.stopPropagation()}>
                            <IpBanControls ip={row.ipAddress} />
                          </span>
                        )}
                      </TableCell>
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

      <DebugLogDetailDialog
        entry={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  )
}
