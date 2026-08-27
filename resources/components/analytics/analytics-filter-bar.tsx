/**
 * IP / country / city filter bar for the analytics page. Filters every chart
 * and top-list on the page via AnalyticsFiltersContext (not geo-time-series,
 * which stays unfiltered). Country/city options are lazy-loaded facets.
 * Renders in a FilterRail on desktop and inside a FiltersDrawer on mobile.
 */
import { useState } from "react"
import { FilterField, FilterPair, FilterRail, FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAccessLogFacets } from "@/lib/queries"
import { isValidIp } from "@/lib/crowdsec"
import {
  countActiveAnalyticsFilters,
  EMPTY_FILTERS,
  useAnalyticsFilters,
} from "@/lib/analytics-filters-context"

type IpKey = "ips" | "ipsExclude"

export function AnalyticsFilterBar() {
  const isMobile = useIsMobile()
  const { filters, setFilters } = useAnalyticsFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })

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

  const activeCount = countActiveAnalyticsFilters(filters)
  const clear = () => setFilters(() => EMPTY_FILTERS)

  if (isMobile) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          {ipPair(true)}
          {country(true)}
          {city(true)}
          {chipRow}
        </FiltersDrawer>
      </div>
    )
  }

  return (
    <FilterRail label="Traffic filters" activeCount={activeCount} onClear={clear}>
      <FilterRow>
        {ipPair(false)}
        {country(false)}
        {city(false)}
      </FilterRow>
      {chipRow}
    </FilterRail>
  )
}
