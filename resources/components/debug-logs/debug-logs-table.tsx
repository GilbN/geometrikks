/**
 * Debug-lines table: server-paginated, newest-first, scoped to the global
 * time range. Filters: combined raw-line/parse-error search, IP, country,
 * city, malformed tri-state. Clicking a row opens the raw-line detail
 * dialog. Pairs with GET /api/v1/access-log-debug/.
 */
import { memo, useCallback, useEffect, useId, useMemo, useState } from "react"
import { useSearch } from "@tanstack/react-router"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { FileWarning, Flag, Hash, MapPin, Search } from "lucide-react"
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { sortOptions } from "@/components/data/sort-options"
import { SortableHead } from "@/components/data/sortable-head"
import { CombinedSortHead } from "@/components/data/combined-sort-head"
import { TableSortDrawer } from "@/components/data/table-sort-drawer"
import { formatRowTime } from "@/lib/row-time"
import { VirtualTable, VirtualTableBody } from "@/components/data/virtual-table"
import { useTimeRange } from "@/lib/time-range-context"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { FilterField } from "@/components/data/filter-rail"
import { FilterBar } from "@/components/data/filter-bar"
import { listField, typedField, type FilterBarField } from "@/components/data/filter-bar-fields"
import { FilterBarToolsProvider } from "@/components/data/filter-bar-slot"
import { FilterChoiceRow, FilterListRow, FilterSection } from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { DebugLogDetailSheet } from "@/components/debug-logs/debug-log-detail-sheet"
import {
  DEBUG_LOG_COLUMNS,
  combinedDebugLogColumns,
  type DebugLogColumn,
  type DebugLogCombinedColumn,
} from "@/components/debug-logs/columns"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { rowActivation } from "@/components/data/row-activation"
import { dataState } from "@/components/data/types"
import { IpActionsMenu, IpFilterTargetsProvider } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import {
  countryLabel,
  listFilterTarget,
  singleFilterTarget,
  type IpRowValues,
} from "@/lib/ip-filter-targets"
import { useAccessLogDebug, useAccessLogFacets, useCrowdsecLiveUpdates } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { countryDisplayName } from "@/lib/country-flags"
import { ipFilterHint, isValidIpFilter } from "@/lib/ip-filter-values"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import type { AccessLogDebugEntry, AccessLogDebugSortField, SortOrder } from "@/lib/api"
import { cn } from "@/lib/utils"
import { statusBadgeClass } from "@/lib/status-badge"
import { useColumnVisibility } from "@/lib/column-visibility"
import { TableTime } from "@/components/data/table-time"
import { TableViewMenu } from "@/components/data/table-view-menu"
import {
  defaultPageSize,
  useTableView,
  useTimeFormat,
  type ColumnLayout,
  type TimeFormat,
} from "@/lib/table-view"

const PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000] as const
export const DEBUG_LOGS_TABLE_ID = "debug-logs"

type MalformedFilter = "all" | "malformed" | "wellformed"
const MALFORMED_OPTIONS: { value: MalformedFilter; label: string }[] = [
  { value: "all", label: "All lines" },
  { value: "malformed", label: "Malformed only" },
  { value: "wellformed", label: "Well-formed only" },
]

function renderCell(
  column: DebugLogColumn,
  r: AccessLogDebugEntry,
  timeFormat: TimeFormat,
): React.ReactNode {
  switch (column.key) {
    case "createdAt":
      return <TableTime value={r.createdAt} format={timeFormat} />
    case "isMalformed":
      return r.isMalformed ? (
        <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
          Yes
        </Badge>
      ) : (
        <span className="text-muted-foreground">No</span>
      )
    case "parseError":
      return (
        <span className="block truncate" title={r.parseError ?? undefined}>
          {r.parseError ?? "-"}
        </span>
      )
    case "logFormat":
      return <span className="whitespace-nowrap font-mono">{r.logFormat ?? "-"}</span>
    case "rawLine":
      return (
        <span className="block truncate font-mono" title={r.rawLine}>
          {r.rawLine}
        </span>
      )
    case "statusCode":
      return r.statusCode != null ? (
        <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(r.statusCode))}>
          {r.statusCode}
        </Badge>
      ) : (
        <span className="text-muted-foreground">-</span>
      )
    case "method":
      return <span className="font-mono">{r.method ?? "-"}</span>
    case "ipAddress":
      return r.ipAddress ? <IpLabel ip={r.ipAddress} /> : <span className="font-mono">-</span>
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
    case "timestamp":
      return r.timestamp ? (
        <TableTime value={r.timestamp} format={timeFormat} />
      ) : (
        <span className="text-muted-foreground">-</span>
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
    case "userAgent":
      return (
        <span className="block truncate font-mono" title={r.userAgent ?? undefined}>
          {r.userAgent ?? "-"}
        </span>
      )
  }
}

function renderCombinedCell(
  column: DebugLogCombinedColumn,
  r: AccessLogDebugEntry,
  timeFormat: TimeFormat,
): React.ReactNode {
  const has = (key: string) => column.fields.some((field) => field.key === key)
  switch (column.key) {
    case "result":
      if (!has("isMalformed")) {
        return r.parseError ? (
          <span className="block truncate text-muted-foreground" title={r.parseError}>
            {r.parseError}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      }
      if (!r.isMalformed) return <span className="text-muted-foreground">Parsed</span>
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Badge className="shrink-0 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
            Malformed
          </Badge>
          {has("parseError") && r.parseError && (
            <span className="min-w-0 truncate text-muted-foreground" title={r.parseError}>
              {r.parseError}
            </span>
          )}
        </span>
      )
    case "rawLine":
      return (
        <span className="block truncate font-mono text-xs" title={r.rawLine}>
          {r.rawLine}
        </span>
      )
    case "request": {
      const status = has("statusCode") ? r.statusCode : null
      const method = has("method") ? r.method : null
      const host = has("host") ? r.host : null
      const url = has("url") ? r.url : null
      if (status == null && !method && !host && !url) {
        return <span className="text-muted-foreground">-</span>
      }
      const target = `${host ?? ""}${url ?? ""}`
      const title = [status != null ? String(status) : null, method, target]
        .filter(Boolean)
        .join(" ")
      return (
        <span className="flex min-w-0 items-center gap-2" title={title || undefined}>
          {status != null && (
            <Badge
              className={cn("shrink-0 tabular-nums border-transparent", statusBadgeClass(status))}
            >
              {status}
            </Badge>
          )}
          {method && (
            <span
              className={cn(
                "shrink-0 font-mono text-[11px] font-semibold",
                (host || url) && "max-w-20 truncate",
                method !== "GET" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
              )}
            >
              {method}
            </span>
          )}
          {(host || url) && (
            <span className="flex min-w-0 flex-1 items-baseline gap-2 font-mono">
              {host && (
                <span
                  className={cn("min-w-0 truncate text-muted-foreground", url && "max-w-[50%]")}
                >
                  {host}
                </span>
              )}
              {url && <span className="min-w-0 flex-1 truncate">{url}</span>}
            </span>
          )}
        </span>
      )
    }
    case "client":
      return r.ipAddress ? (
        <span className="flex items-center gap-1.5">
          <IpLabel ip={r.ipAddress} short />
          <DebugLogIpActions row={r} />
        </span>
      ) : (
        <span className="text-muted-foreground">-</span>
      )
    default:
      return renderCell(column.fields[0], r, timeFormat)
  }
}

const getRowKey = (row: AccessLogDebugEntry) => row.id

const shortcutValues = (row: AccessLogDebugEntry): IpRowValues | null =>
  row.ipAddress
    ? {
        ip: row.ipAddress,
        countryCode: row.countryCode,
        countryName: row.countryName,
        city: row.city,
      }
    : null

/** The filter F applies on a column, when the page filters on its field. */
const FILTER_NOUNS: Partial<Record<DebugLogColumn["key"], string>> = {
  ipAddress: "IP",
  country: "country",
}

/** A combined column filters on the field its header sorts by. */
function combinedFilterNoun(column: DebugLogCombinedColumn): string | undefined {
  const main = column.fields.find((field) => field.sortField) ?? column.fields[0]
  return main ? FILTER_NOUNS[main.key] : undefined
}

const SORT_OPTIONS = sortOptions(DEBUG_LOG_COLUMNS)

function DebugLogIpActions({ row }: { row: AccessLogDebugEntry }) {
  if (!row.ipAddress) return null
  return (
    <IpActionsMenu
      ip={row.ipAddress}
      countryCode={row.countryCode}
      countryName={row.countryName}
      city={row.city}
    />
  )
}

/** A narrow row: the raw line and whether it parsed on top, when and from where below. */
function DebugLogNarrowCell({
  row,
  timeFormat,
}: {
  row: AccessLogDebugEntry
  timeFormat: TimeFormat
}) {
  return (
    <TableCell className="py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {row.isMalformed && (
          <Badge className="shrink-0 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
            Malformed
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={row.rawLine}>
          {row.rawLine}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {formatRowTime(row.createdAt, { format: timeFormat })}
        </span>
        {row.parseError && (
          <span className="min-w-0 truncate text-muted-foreground" title={row.parseError}>
            {row.parseError}
          </span>
        )}
        {row.ipAddress && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            <IpLabel ip={row.ipAddress} className="truncate" />
            <DebugLogIpActions row={row} />
          </span>
        )}
      </div>
    </TableCell>
  )
}

const DebugLogTableBody = memo(function DebugLogTableBody({
  rows,
  shownColumns,
  combinedColumns,
  layout,
  narrow,
  timeFormat,
  onSelect,
}: {
  rows: AccessLogDebugEntry[]
  shownColumns: DebugLogColumn[]
  combinedColumns: DebugLogCombinedColumn[]
  layout: ColumnLayout
  narrow: boolean
  timeFormat: TimeFormat
  onSelect: (row: AccessLogDebugEntry) => void
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
          key={row.id}
          aria-label={`Debug line ${row.id}, ${row.isMalformed ? "malformed" : "parsed"}`}
          {...rowActivation<HTMLTableRowElement>(() => onSelect(row))}
        >
          {narrow ? (
            <DebugLogNarrowCell row={row} timeFormat={timeFormat} />
          ) : layout === "combined" ? (
            combinedColumns.map((c) => (
              <TableCell
                key={c.key}
                data-filter-noun={combinedFilterNoun(c)}
                className={cn((c.grow || c.width) && "max-w-0 truncate")}
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
                className={cn(c.grow && "max-w-0 truncate")}
              >
                {renderCell(c, row, timeFormat)}
                {c.key === "ipAddress" && <DebugLogIpActions row={row} />}
              </TableCell>
            ))
          )}
        </TableRow>
      )}
    </VirtualTableBody>
  )
})

export function DebugLogsTable() {
  const { range, customRange } = useTimeRange()
  const isMobile = useIsMobile()
  const phone = usePhoneLayout()
  const [page, setPage] = useState(1)
  const { density, layout, setDensity, setLayout, resetView, hasViewOverrides } =
    useTableView(DEBUG_LOGS_TABLE_ID)
  const [timeFormat] = useTimeFormat()
  // Follows the density until the user picks a size.
  const [pickedPageSize, setPageSize] = useState<number | null>(null)
  const pageSize = pickedPageSize ?? defaultPageSize(density)

  // Filters (raw input; text inputs are debounced before hitting the query).
  const initial = useSearch({
    from: "/debug-logs",
    select: ({ ip, malformed }) => ({ ip, malformed }),
    structuralSharing: true,
  })
  const [searchInput, setSearchInput] = useState("")
  const [ipInput, setIpInput] = useState(initial.ip ?? "")
  const [cities, setCities] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  const filterTargetsFor = useCallback(
    ({ ip, countryCode, countryName }: IpRowValues) => [
      singleFilterTarget({
        noun: "IP",
        value: ip,
        current: ipInput || undefined,
        setValue: (next) => setIpInput(next ?? ""),
      }),
      ...(countryCode
        ? [
            listFilterTarget({
              noun: "country",
              value: countryCode,
              label: countryLabel(countryCode, countryName),
              filters: { countries },
              setFilters: (updater) =>
                setCountries((prev) => updater({ countries: prev }).countries),
              includeKey: "countries",
              excludeKey: null,
            }),
          ]
        : []),
    ],
    [ipInput, countries],
  )
  const [malformedFilter, setMalformedFilter] = useState<MalformedFilter>(
    initial.malformed ?? "all",
  )
  // Facet values are fetched lazily, on first open of either dropdown.
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })
  const search = useDebouncedValue(searchInput, 300)
  const ip = useDebouncedValue(ipInput.trim(), 300)
  const ipDraft = ipInput.trim()
  const ipInvalid = ipDraft !== "" && !isValidIpFilter(ipDraft)
  const ipHint = ipInvalid ? ipFilterHint(ipDraft) : null
  const ipHintId = useId()

  // Sorting.
  const [sortField, setSortField] = useState<AccessLogDebugSortField>("createdAt")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  const { visible, shownColumns, toggleColumn, resetColumns, hasOverrides } = useColumnVisibility(
    "geometrikks-columns-debug-logs",
    DEBUG_LOG_COLUMNS,
  )
  const combinedColumns = useMemo(() => combinedDebugLogColumns(shownColumns), [shownColumns])

  // Detail sheet.
  const [selected, setSelected] = useState<AccessLogDebugEntry | null>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  // Under the filter bar the rows take the height the page has left.
  const fill = !phone && !narrow

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
    // Only forward complete values; partial text cannot match an INET column.
    ipAddressIn: ip && isValidIpFilter(ip) ? [ip] : undefined,
    countryCodeIn: countries.length ? countries : undefined,
    cityIn: cities.length ? cities : undefined,
    malformed: malformedFilter === "all" ? undefined : malformedFilter === "malformed",
    sortField,
    sortOrder,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const state = dataState(isLoading, isError, rows.length)

  function setSort(field: AccessLogDebugSortField, order: SortOrder) {
    setSortField(field)
    setSortOrder(order)
  }

  function toggleSort(field: AccessLogDebugSortField) {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  const activeFilterCount =
    (search ? 1 : 0) +
    (ip ? 1 : 0) +
    (malformedFilter !== "all" ? 1 : 0) +
    (countries.length ? 1 : 0) +
    (cities.length ? 1 : 0)

  function clearFilters() {
    setSearchInput("")
    setIpInput("")
    setMalformedFilter("all")
    setCountries([])
    setCities([])
  }

  function renderDrawerFilters() {
    const searchField = (
      <FilterField label="Search">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Raw line or parse error"
            className="h-8 w-full pl-7 text-xs"
          />
        </div>
      </FilterField>
    )
    const ipField = (
      <FilterField label="IP address" className="w-full">
        <Input
          value={ipInput}
          onChange={(e) => setIpInput(e.target.value)}
          placeholder="203.0.113.7"
          aria-invalid={ipInvalid}
          aria-describedby={ipHint ? ipHintId : undefined}
          className="h-8 w-full font-mono text-xs"
        />
        {ipHint && (
          <span
            id={ipHintId}
            aria-hidden
            className="block break-all font-mono text-[11px] text-destructive"
          >
            {ipHint}
          </span>
        )}
      </FilterField>
    )
    return (
      <>
        {searchField}
        {ipField}
        <FilterSection>
          <FilterChoiceRow
            label="Lines"
            options={MALFORMED_OPTIONS}
            value={malformedFilter}
            onChange={setMalformedFilter}
          />
          <FilterListRow
            label="Country"
            search
            iconFor={(code) => <CountryFlag code={code} />}
            options={facets?.countries.map((c) => c.code) ?? []}
            selected={countries}
            onChange={setCountries}
            labelFor={(code) => {
              const name = facets?.countries.find((c) => c.code === code)?.name
              return name ? `${name} (${code})` : code
            }}
            valueFor={(code) => facets?.countries.find((c) => c.code === code)?.name ?? code}
            loading={!facets}
            emptyText="No geo data"
          />
          <FilterListRow
            label="City"
            search
            options={facets?.cities ?? []}
            selected={cities}
            onChange={setCities}
            loading={!facets}
            emptyText="No geo data"
          />
        </FilterSection>
      </>
    )
  }

  // The browser names a country until the facets arrive.
  const countryNameFor = (code: string) =>
    facets?.countries.find((c) => c.code === code)?.name ?? countryDisplayName(code)
  const countryLabelFor = (code: string) => {
    const name = countryNameFor(code)
    return name ? `${name} (${code})` : code
  }
  const loadFacets = () => setFacetsEnabled(true)
  const barFields: FilterBarField[] = [
    typedField({
      id: "ip",
      label: "IP address",
      chipLabel: "IP",
      icon: Hash,
      // The page filters by one address or range, so a new one replaces it.
      include: ipDraft ? [ipDraft] : [],
      onChange: (include) => setIpInput(include.at(-1) ?? ""),
      labelFor: String,
      mono: true,
      validate: isValidIpFilter,
      hint: ipFilterHint,
      placeholder: "203.0.113.7",
      help: "Takes one address or a CIDR range.",
    }),
    listField<MalformedFilter>({
      id: "lines",
      label: "Lines",
      icon: FileWarning,
      // One choice at a time: the last tick wins, and none means all lines.
      include: malformedFilter === "all" ? [] : [malformedFilter],
      onChange: (include) => setMalformedFilter(include.at(-1) ?? "all"),
      labelFor: (value) => MALFORMED_OPTIONS.find((option) => option.value === value)!.label,
      options: ["malformed", "wellformed"],
    }),
    listField({
      id: "country",
      label: "Country",
      icon: Flag,
      include: countries,
      onChange: setCountries,
      labelFor: countryLabelFor,
      chipValue: (code) => (
        <>
          <CountryFlag code={code} />
          {countryNameFor(code) ?? code}
        </>
      ),
      iconFor: (code) => <CountryFlag code={code} />,
      options: facets?.countries.map((c) => c.code) ?? [],
      loading: !facets,
      emptyText: "No geo data",
      onOpen: loadFacets,
    }),
    listField({
      id: "city",
      label: "City",
      icon: MapPin,
      include: cities,
      onChange: setCities,
      labelFor: String,
      options: facets?.cities ?? [],
      loading: !facets,
      emptyText: "No geo data",
      onOpen: loadFacets,
    }),
  ]

  const viewMenu = (
    <TableViewMenu
      density={density}
      onDensityChange={setDensity}
      layout={layout}
      onLayoutChange={setLayout}
      layoutHint="Result, Request, Client"
      fields={DEBUG_LOG_COLUMNS}
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
      return <TableHead key={c.key}>{c.label}</TableHead>
    }
    const columnSortField = c.sortField
    return (
      <SortableHead
        key={c.key}
        label={c.label}
        active={sortField === columnSortField}
        sortOrder={sortOrder}
        onToggle={() => toggleSort(columnSortField)}
      />
    )
  })

  const combinedHeader = combinedColumns.map((c) => {
    const options = sortOptions(c.fields)
    if (options.length > 1) {
      return (
        <CombinedSortHead
          key={c.key}
          label={c.label}
          options={options}
          sortField={sortField}
          sortOrder={sortOrder}
          onSortChange={setSort}
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
          onToggle={() => toggleSort(columnSortField)}
        />
      )
    }
    return <TableHead key={c.key}>{c.label}</TableHead>
  })

  return (
    <FilterBarToolsProvider>
      <IpFilterTargetsProvider targetsFor={filterTargetsFor}>
        {/* Around the sheet too, so its IP actions menu gets the page's filters. */}
        <div className={cn(phone ? "space-y-4" : "flex min-h-0 flex-col gap-4")}>
          {phone ? (
            <div onClick={() => setFacetsEnabled(true)}>
              <FiltersDrawer activeCount={activeFilterCount} onClear={clearFilters}>
                {renderDrawerFilters()}
              </FiltersDrawer>
            </div>
          ) : (
            <FilterBar
              label="Debug filters"
              pageId="debug-logs"
              search={
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    aria-label="Search"
                    placeholder="Raw line or parse error"
                    className="h-8 w-[214px] pl-8 md:text-[13px]"
                    data-page-filter=""
                  />
                </div>
              }
              fields={barFields}
              activeCount={activeFilterCount}
              onClear={clearFilters}
            />
          )}

          <div
            ref={layoutRef}
            data-table-fill={fill || undefined}
            className={cn(fill && "flex min-h-0 flex-col")}
          >
            <DataTableFrame
              fill={fill}
              title="Captured source lines"
              description="Raw parser input and linked request context. Select a row for the complete record."
              count={data ? total : undefined}
              stickyHeader={narrow && isMobile}
              tools={
                narrow ? (
                  <TableSortDrawer
                    options={SORT_OPTIONS}
                    sortField={sortField}
                    sortOrder={sortOrder}
                    onSortChange={setSort}
                  />
                ) : (
                  viewMenu
                )
              }
              state={state}
              error="Failed to load debug logs."
              empty="No debug lines match these filters."
              footer={
                <PaginationFooter
                  page={page}
                  pageCount={pageCount}
                  total={total}
                  onPageChange={setPage}
                  disabled={isPlaceholderData}
                  pageSize={pageSize}
                  pageSizes={PAGE_SIZES}
                  onPageSizeChange={setPageSize}
                />
              }
            >
              <VirtualTable
                narrow={narrow}
                fill={fill}
                density={density}
                columns={layout === "combined" ? combinedColumns : shownColumns}
                rowCount={rows.length}
                resetKey={JSON.stringify([
                  page,
                  pageSize,
                  sortField,
                  sortOrder,
                  search,
                  ip,
                  cities,
                  countries,
                  malformedFilter,
                  range,
                  customRange,
                ])}
              >
                {!narrow && (
                  <TableHeader>
                    <TableRow>{layout === "combined" ? combinedHeader : separateHeader}</TableRow>
                  </TableHeader>
                )}
                <DebugLogTableBody
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

          <DebugLogDetailSheet
            entry={selected}
            onOpenChange={(open) => !open && setSelected(null)}
          />
        </div>
      </IpFilterTargetsProvider>
    </FilterBarToolsProvider>
  )
}
