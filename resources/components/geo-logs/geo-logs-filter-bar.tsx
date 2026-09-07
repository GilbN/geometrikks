/**
 * Filter bar for the geo-logs page: IP include/exclude, country, city and
 * hostname multiselects, and an ASN include/exclude combobox pair
 * (lazy-loaded facets). Renders in a FilterRail on desktop and inside a
 * FiltersDrawer on mobile. Everything on the page (map, stats, chart, top
 * lists, table) reshapes through GeoLogFiltersContext, whose state lives in
 * the URL search params.
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

  const asnLabel = (asn: number) => {
    const org = facets?.asns.find((a) => a.asn === asn)?.organization
    return org ? `AS${asn} ${org}` : `AS${asn}`
  }
  type AsnKey = "asns" | "asnsExclude"
  const setAsns = (key: AsnKey) => (values: number[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }))
  const removeAsn = (key: AsnKey, asn: number) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== asn) }))

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

  const asnPair = (inDrawer: boolean) => (
    <FilterPair
      label="ASN"
      excludeLabel="Exclude ASN"
      stacked={inDrawer}
      include={
        <FilterCombobox<number>
          label="ASN"
          options={facets?.asns.map((a) => a.asn) ?? []}
          selected={filters.asns}
          onChange={setAsns("asns")}
          labelFor={asnLabel}
          loading={!facets}
          emptyText="No ASN data"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
          forceInline={inDrawer}
        />
      }
      exclude={
        <FilterCombobox<number>
          label="Exclude ASN"
          options={facets?.asns.map((a) => a.asn) ?? []}
          selected={filters.asnsExclude}
          onChange={setAsns("asnsExclude")}
          labelFor={asnLabel}
          loading={!facets}
          emptyText="No ASN data"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
          forceInline={inDrawer}
        />
      }
    />
  )

  const chips = [
    ...filters.ips.map((v) => ({ key: "ips" as const, label: v, exclude: false, remove: () => removeIp("ips", v) })),
    ...filters.ipsExclude.map((v) => ({ key: "ipsExclude" as const, label: v, exclude: true, remove: () => removeIp("ipsExclude", v) })),
    ...filters.asns.map((v) => ({ key: "asns" as const, label: asnLabel(v), exclude: false, remove: () => removeAsn("asns", v) })),
    ...filters.asnsExclude.map((v) => ({ key: "asnsExclude" as const, label: asnLabel(v), exclude: true, remove: () => removeAsn("asnsExclude", v) })),
  ]
  const chipRow = chips.length > 0 && (
    <FilterRow>
      {chips.map((c) => (
        <FilterChip key={`${c.key}:${c.label}`} value={c.label} exclude={c.exclude} onRemove={c.remove} />
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
          {asnPair(true)}
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
        {asnPair(false)}
      </FilterRow>
      {chipRow}
    </FilterRail>
  )
}
