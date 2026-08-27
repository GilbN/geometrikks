/**
 * Filter bar for the geo-logs page: IP include/exclude plus country, city
 * and hostname multiselects (lazy-loaded facets). Renders in a FilterRail on
 * desktop and inside a FiltersDrawer on mobile. Everything on the page (map,
 * stats, chart, top lists, table) reshapes through GeoLogFiltersContext,
 * whose state lives in the URL search params.
 */
import { useState } from "react"
import { FilterField, FilterPair, FilterRail, FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import { useGeoEventFacets } from "@/lib/queries"
import { isValidIp } from "@/lib/crowdsec"
import {
  countActiveGeoLogFilters,
  EMPTY_GEO_LOG_FILTERS,
  useGeoLogFilters,
} from "@/lib/geo-log-filters-context"

type IpKey = "ips" | "ipsExclude"

export function GeoLogsFilterBar() {
  const isMobile = useIsMobile()
  const { filters, setFilters } = useGeoLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useGeoEventFacets({ enabled: facetsEnabled })

  const addIp = (key: IpKey) => (value: string) => {
    if (filters[key].includes(value)) return
    setFilters((prev) => ({ ...prev, [key]: [...prev[key], value] }))
  }
  const removeIp = (key: IpKey, ip: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))

  const ipPair = (inDrawer: boolean) => (
    <FilterPair
      label="IP address"
      excludeLabel="Exclude IP"
      stacked={inDrawer}
      include={
        <TagInput
          onAdd={addIp("ips")}
          validate={isValidIp}
          placeholder="203.0.113.7"
          className={inDrawer ? "w-full" : "w-36"}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={addIp("ipsExclude")}
          validate={isValidIp}
          placeholder="Exclude"
          className={inDrawer ? "w-full" : "w-32"}
        />
      }
    />
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
  const hostname = (inDrawer: boolean) => (
    <FilterField label="Hostname" hideLabel={!inDrawer}>
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
    </FilterField>
  )

  const chips = [
    ...filters.ips.map((v) => ({ key: "ips" as const, v, exclude: false })),
    ...filters.ipsExclude.map((v) => ({ key: "ipsExclude" as const, v, exclude: true })),
  ]
  const chipRow = chips.length > 0 && (
    <FilterRow>
      {chips.map((c) => (
        <FilterChip key={`${c.key}:${c.v}`} value={c.v} exclude={c.exclude} onRemove={() => removeIp(c.key, c.v)} />
      ))}
    </FilterRow>
  )

  const activeCount = countActiveGeoLogFilters(filters)
  const clear = () => setFilters(() => EMPTY_GEO_LOG_FILTERS)

  if (isMobile) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          {ipPair(true)}
          {country(true)}
          {city(true)}
          {hostname(true)}
          {chipRow}
        </FiltersDrawer>
      </div>
    )
  }

  return (
    <FilterRail label="Location filters" activeCount={activeCount} onClear={clear}>
      <FilterRow>
        {ipPair(false)}
        {country(false)}
        {city(false)}
        {hostname(false)}
      </FilterRow>
      {chipRow}
    </FilterRail>
  )
}
