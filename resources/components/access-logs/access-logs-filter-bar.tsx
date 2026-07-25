/**
 * Filter controls for the access-logs history table: search, IP, host,
 * status, method, country and city. Renders inline on desktop and inside a
 * FiltersDrawer on mobile. State lives in the URL via
 * AccessLogFiltersContext, so every control is a controlled input over the
 * route's search params.
 */
import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer, FilterSection } from "@/components/ui/filters-drawer"
import { useAccessLogFacets } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  countActiveAccessLogFilters,
  useAccessLogFilters,
} from "@/lib/access-log-filters-context"

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

export function AccessLogsFilterBar() {
  const isMobile = useIsMobile()
  const { filters, setFilters } = useAccessLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })

  // The search box is the one free-text field left, so it stays local and
  // debounced: writing every keystroke to the URL would spam navigation.
  const [searchInput, setSearchInput] = useState(filters.search)
  const debouncedSearch = useDebouncedValue(searchInput, 300)

  // Tracks the last value this component pushed to the URL, so the two
  // effects below can tell "the user typed" apart from "the URL moved on its
  // own". Without it they fight: when the URL changes externally (a pasted
  // link, "Clear filters"), filters.search moves while debouncedSearch still
  // holds the old text, and a naive push effect shoves the stale value
  // straight back into the URL.
  const lastPushed = useRef(filters.search)

  // Typing -> URL, once the value settles.
  useEffect(() => {
    if (debouncedSearch === lastPushed.current) return
    lastPushed.current = debouncedSearch
    setFilters((prev) => ({ ...prev, search: debouncedSearch }))
  }, [debouncedSearch, setFilters])

  // URL -> box, but only when the URL moved for a reason other than our own
  // push (back/forward, a pasted link, "Clear filters").
  useEffect(() => {
    if (filters.search === lastPushed.current) return
    lastPushed.current = filters.search
    setSearchInput(filters.search)
  }, [filters.search])

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
              placeholder="Search url / referrer / agent…"
              className={cn("h-8 pl-7 text-xs", inDrawer ? "w-full" : "w-64")}
            />
          </div>,
        )}
        {wrap(
          "Status",
          <FilterCombobox
            label="Status"
            options={[...STATUS_CODES]}
            selected={filters.statusCodes}
            onChange={(values) => setFilters((prev) => ({ ...prev, statusCodes: values }))}
            forceInline={inDrawer}
          />,
        )}
        {wrap(
          "Method",
          <FilterCombobox
            label="Method"
            options={[...HTTP_METHODS]}
            selected={filters.methods}
            onChange={(values) => setFilters((prev) => ({ ...prev, methods: values }))}
            forceInline={inDrawer}
          />,
        )}
        {wrap(
          "Country",
          <FilterCombobox
            label="Country"
            options={facets?.countries.map((c) => c.code) ?? []}
            selected={filters.countryCodes}
            onChange={(values) => setFilters((prev) => ({ ...prev, countryCodes: values }))}
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
            selected={filters.cities}
            onChange={(values) => setFilters((prev) => ({ ...prev, cities: values }))}
            loading={!facets}
            emptyText="No geo data"
            onOpenChange={(open) => open && setFacetsEnabled(true)}
            forceInline={inDrawer}
          />,
        )}
      </>
    )
  }

  if (isMobile) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={countActiveAccessLogFilters(filters)}>
          {renderFilters(true)}
        </FiltersDrawer>
      </div>
    )
  }

  return <div className="flex flex-wrap items-center gap-2">{renderFilters(false)}</div>
}
