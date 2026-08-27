/**
 * Filter controls for the access-logs history table. Renders in a FilterRail
 * on desktop (text inputs on one row, selects on the next) and as a flat list
 * inside a FiltersDrawer on mobile. State
 * lives in the URL via AccessLogFiltersContext, so every control is a
 * controlled input over the route's search params.
 */
import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { FilterField, FilterPair, FilterRail, FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAccessLogFacets } from "@/lib/queries"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useIsMobile } from "@/hooks/use-mobile"
import { isValidIp } from "@/lib/crowdsec"
import { cn } from "@/lib/utils"
import {
  countActiveAccessLogFilters,
  EMPTY_ACCESS_LOG_FILTERS,
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

type ListKey = "ips" | "ipsExclude" | "hostsExclude" | "hostnamesExclude"

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

  const add = (key: ListKey) => (value: string) => {
    if (filters[key].includes(value)) return
    setFilters((prev) => ({ ...prev, [key]: [...prev[key], value] }))
  }
  const remove = (key: ListKey, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== value) }))

  const search = (inDrawer: boolean) => (
    <FilterField label="Search">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="URL, referrer or user agent"
          className={cn("h-8 pl-7 text-xs", inDrawer ? "w-full" : "w-64")}
        />
      </div>
    </FilterField>
  )
  const ipPair = (inDrawer: boolean) => (
    <FilterPair
      label="IP address"
      excludeLabel="Exclude IP"
      stacked={inDrawer}
      include={
        <TagInput
          onAdd={add("ips")}
          validate={isValidIp}
          placeholder="203.0.113.7"
          className={inDrawer ? "w-full" : "w-36"}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("ipsExclude")}
          validate={isValidIp}
          placeholder="Exclude"
          className={inDrawer ? "w-full" : "w-32"}
        />
      }
    />
  )
  const hostPair = (inDrawer: boolean) => (
    <FilterPair
      label="Host"
      excludeLabel="Exclude host"
      stacked={inDrawer}
      include={
        <FilterCombobox
          label="Host"
          options={facets?.hosts ?? []}
          selected={filters.hosts}
          onChange={(values) => setFilters((prev) => ({ ...prev, hosts: values }))}
          loading={!facets}
          emptyText="No hosts"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
          forceInline={inDrawer}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("hostsExclude")}
          placeholder="Exclude"
          className={inDrawer ? "w-full" : "w-36"}
        />
      }
    />
  )
  const hostnamePair = (inDrawer: boolean) => (
    <FilterPair
      label="Hostname"
      excludeLabel="Exclude hostname"
      stacked={inDrawer}
      include={
        <FilterCombobox
          label="Hostname"
          options={facets?.hostnames ?? []}
          selected={filters.hostnames}
          onChange={(values) => setFilters((prev) => ({ ...prev, hostnames: values }))}
          loading={!facets}
          emptyText="No hostnames"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
          forceInline={inDrawer}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("hostnamesExclude")}
          placeholder="Exclude"
          className={inDrawer ? "w-full" : "w-36"}
        />
      }
    />
  )
  const method = (inDrawer: boolean) => (
    <FilterField label="Method" hideLabel={!inDrawer}>
      <FilterCombobox
        label="Method"
        options={[...HTTP_METHODS]}
        selected={filters.methods}
        onChange={(values) => setFilters((prev) => ({ ...prev, methods: values }))}
        forceInline={inDrawer}
      />
    </FilterField>
  )
  const status = (inDrawer: boolean) => (
    <FilterField label="Status" hideLabel={!inDrawer}>
      <FilterCombobox
        label="Status"
        options={[...STATUS_CODES]}
        selected={filters.statusCodes}
        onChange={(values) => setFilters((prev) => ({ ...prev, statusCodes: values }))}
        forceInline={inDrawer}
      />
    </FilterField>
  )
  const country = (inDrawer: boolean) => (
    <FilterField label="Country" hideLabel={!inDrawer}>
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
      />
    </FilterField>
  )
  const city = (inDrawer: boolean) => (
    <FilterField label="City" hideLabel={!inDrawer}>
      <FilterCombobox
        label="City"
        options={facets?.cities ?? []}
        selected={filters.cities}
        onChange={(values) => setFilters((prev) => ({ ...prev, cities: values }))}
        loading={!facets}
        emptyText="No geo data"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
        forceInline={inDrawer}
      />
    </FilterField>
  )
  const logFormat = (inDrawer: boolean) => (
    <FilterField label="Source format" hideLabel={!inDrawer}>
      <FilterCombobox
        label="Source format"
        options={facets?.logFormats ?? []}
        selected={filters.logFormats}
        onChange={(values) => setFilters((prev) => ({ ...prev, logFormats: values }))}
        loading={!facets}
        emptyText="No formats"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
        forceInline={inDrawer}
      />
    </FilterField>
  )

  const chips = [
    ...filters.ips.map((v) => ({ key: "ips" as const, v, exclude: false })),
    ...filters.ipsExclude.map((v) => ({ key: "ipsExclude" as const, v, exclude: true })),
    ...filters.hostsExclude.map((v) => ({ key: "hostsExclude" as const, v, exclude: true })),
    ...filters.hostnamesExclude.map((v) => ({ key: "hostnamesExclude" as const, v, exclude: true })),
  ]
  const chipRow = chips.length > 0 && (
    <FilterRow>
      {chips.map((c) => (
        <FilterChip key={`${c.key}:${c.v}`} value={c.v} exclude={c.exclude} onRemove={() => remove(c.key, c.v)} />
      ))}
    </FilterRow>
  )

  const activeCount = countActiveAccessLogFilters(filters)
  const clear = () => {
    setSearchInput("")
    setFilters(() => EMPTY_ACCESS_LOG_FILTERS)
  }

  if (isMobile) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          {search(true)}
          {ipPair(true)}
          {hostPair(true)}
          {hostnamePair(true)}
          {method(true)}
          {status(true)}
          {logFormat(true)}
          {country(true)}
          {city(true)}
          {chipRow}
        </FiltersDrawer>
      </div>
    )
  }

  return (
    <FilterRail label="Request filters" activeCount={activeCount} onClear={clear}>
      <FilterRow>
        {search(false)}
        {ipPair(false)}
        {hostPair(false)}
        {hostnamePair(false)}
      </FilterRow>
      <FilterRow>
        {method(false)}
        {status(false)}
        {logFormat(false)}
        {country(false)}
        {city(false)}
      </FilterRow>
      {chipRow}
    </FilterRail>
  )
}
