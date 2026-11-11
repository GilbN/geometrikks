/**
 * Filter bar for the geo-logs page: IP include/exclude, country, city and
 * server multiselects, and an ASN include/exclude combobox pair
 * (lazy-loaded facets). Renders in a FilterRail on desktop and inside a
 * FiltersDrawer on phones. Everything on the page (map, stats, chart, top
 * lists, table) reshapes through GeoLogFiltersContext, whose state lives in
 * the URL search params.
 */
import { CountryFlag } from "@/components/country-flag"
import { useState } from "react"
import { ExcludeMyIpButton, ExcludeMyIpField } from "@/components/data/exclude-my-ip"
import { FilterField, FilterPair, FilterRail, FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FilterExcludedIpRows, FilterListRow, FilterMyIpRow, FilterSection } from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAsnLabel } from "@/hooks/use-asn-label"
import { useMyIpExclusion } from "@/hooks/use-my-ip-exclusion"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useGeoEventFacets } from "@/lib/queries"
import { isValidIp } from "@/lib/crowdsec"
import {
  countActiveGeoLogFilters,
  EMPTY_GEO_LOG_FILTERS,
  useGeoLogFilters,
} from "@/lib/geo-log-filters-context"

type IpKey = "ips" | "ipsExclude"

export function GeoLogsFilterBar() {
  const phone = usePhoneLayout()
  const { filters, setFilters } = useGeoLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useGeoEventFacets({
    enabled: facetsEnabled || filters.asns.length > 0 || filters.asnsExclude.length > 0,
  })

  const addIp = (key: IpKey) => (value: string) => {
    if (filters[key].includes(value)) return
    // A tap on Exclude your IP lands after a lookup, so the closure can be stale.
    setFilters((prev) => (prev[key].includes(value) ? prev : { ...prev, [key]: [...prev[key], value] }))
  }
  const removeIp = (key: IpKey, ip: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))
  const myIp = useMyIpExclusion(filters.ipsExclude, addIp("ipsExclude"), (ip) => removeIp("ipsExclude", ip))

  const asnLabel = useAsnLabel(facets?.asns)
  const countryName = (code: string) => facets?.countries.find((c) => c.code === code)?.name
  const countryLabel = (code: string) => {
    const name = countryName(code)
    return name ? `${name} (${code})` : code
  }
  type AsnKey = "asns" | "asnsExclude"
  const setAsns = (key: AsnKey) => (values: number[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }))
  const removeAsn = (key: AsnKey, asn: number) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== asn) }))

  const chips = [
    ...filters.ips.map((v) => ({ key: "ips" as const, label: v, exclude: false, remove: () => removeIp("ips", v) })),
    ...filters.ipsExclude.map((v) => ({ key: "ipsExclude" as const, label: v, exclude: true, remove: () => removeIp("ipsExclude", v) })),
    ...filters.asns.map((v) => ({ key: "asns" as const, label: asnLabel(v), exclude: false, remove: () => removeAsn("asns", v) })),
    ...filters.asnsExclude.map((v) => ({ key: "asnsExclude" as const, label: asnLabel(v), exclude: true, remove: () => removeAsn("asnsExclude", v) })),
  ]
  const chipRow = (keys: (IpKey | AsnKey)[]) => {
    const shown = chips.filter((c) => keys.includes(c.key))
    return shown.length > 0 && (
      <FilterRow>
        {shown.map((c) => (
          <FilterChip key={`${c.key}:${c.label}`} value={c.label} exclude={c.exclude} onRemove={c.remove} />
        ))}
      </FilterRow>
    )
  }

  const ipPair = () => (
    <FilterPair
      label="IP address"
      excludeLabel="Exclude IP"
      include={
        <TagInput
          onAdd={addIp("ips")}
          validate={isValidIp}
          placeholder="203.0.113.7"
          className="w-36"
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={addIp("ipsExclude")}
          validate={isValidIp}
          placeholder="Exclude"
          className="w-32"
        />
      }
    />
  )
  const country = () => (
    <FilterField label="Country" hideLabel>
      <FilterCombobox
        label="Country"
        iconFor={(code) => <CountryFlag code={code} />}
        options={facets?.countries.map((c) => c.code) ?? []}
        selected={filters.countryCodes}
        onChange={(values) => setFilters((prev) => ({ ...prev, countryCodes: values }))}
        labelFor={countryLabel}
        loading={!facets}
        emptyText="No geo data"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
      />
    </FilterField>
  )
  const city = () => (
    <FilterField label="City" hideLabel>
      <FilterCombobox
        label="City"
        options={facets?.cities ?? []}
        selected={filters.cities}
        onChange={(values) => setFilters((prev) => ({ ...prev, cities: values }))}
        loading={!facets}
        emptyText="No geo data"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
      />
    </FilterField>
  )
  const server = () => (
    <FilterField label="Server" hideLabel>
      <FilterCombobox
        label="Server"
        options={facets?.servers ?? []}
        selected={filters.servers}
        onChange={(values) => setFilters((prev) => ({ ...prev, servers: values }))}
        loading={!facets}
        emptyText="No servers"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
      />
    </FilterField>
  )

  const asnPair = () => (
    <FilterPair
      label="ASN"
      excludeLabel="Exclude ASN"
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
        />
      }
    />
  )

  const activeCount = countActiveGeoLogFilters(filters)
  const clear = () => setFilters(() => EMPTY_GEO_LOG_FILTERS)

  if (phone) {
    return (
      <div className="flex items-center gap-2" onClick={() => setFacetsEnabled(true)}>
        <ExcludeMyIpButton exclusion={myIp} />
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          <TagInput
            onAdd={addIp("ips")}
            validate={isValidIp}
            placeholder="203.0.113.7"
            aria-label="IP address"
            className="w-full"
            inputClassName="h-10"
          />
          {chipRow(["ips"])}
          <FilterSection label="Show only">
            <FilterListRow
              label="Country"
              search
              iconFor={(code) => <CountryFlag code={code} />}
              options={facets?.countries.map((c) => c.code) ?? []}
              selected={filters.countryCodes}
              onChange={(values) => setFilters((prev) => ({ ...prev, countryCodes: values }))}
              labelFor={countryLabel}
              valueFor={(code) => countryName(code) ?? code}
              loading={!facets}
              emptyText="No geo data"
            />
            <FilterListRow
              label="City"
              search
              options={facets?.cities ?? []}
              selected={filters.cities}
              onChange={(values) => setFilters((prev) => ({ ...prev, cities: values }))}
              loading={!facets}
              emptyText="No geo data"
            />
            <FilterListRow
              label="Server"
              options={facets?.servers ?? []}
              selected={filters.servers}
              onChange={(values) => setFilters((prev) => ({ ...prev, servers: values }))}
              loading={!facets}
              emptyText="No servers"
            />
            <FilterListRow<number>
              label="ASN"
              search
              options={facets?.asns.map((a) => a.asn) ?? []}
              selected={filters.asns}
              onChange={setAsns("asns")}
              labelFor={asnLabel}
              splitLabel
              loading={!facets}
              emptyText="No ASN data"
            />
          </FilterSection>
          <FilterSection label="Exclude">
            <FilterMyIpRow exclusion={myIp} />
            <FilterExcludedIpRows values={filters.ipsExclude} onAdd={addIp("ipsExclude")} onRemove={(ip) => removeIp("ipsExclude", ip)} validate={isValidIp} />
            <FilterListRow<number>
              label="ASN" exclude
              search
              options={facets?.asns.map((a) => a.asn) ?? []}
              selected={filters.asnsExclude}
              onChange={setAsns("asnsExclude")}
              labelFor={asnLabel}
              splitLabel
              loading={!facets}
              emptyText="No ASN data"
            />
          </FilterSection>
        </FiltersDrawer>
      </div>
    )
  }

  return (
    <FilterRail label="Location filters" activeCount={activeCount} onClear={clear}>
      <FilterRow>
        {ipPair()}
        <ExcludeMyIpField exclusion={myIp} />
        {country()}
        {city()}
        {server()}
        {asnPair()}
      </FilterRow>
      {chipRow(["ips", "ipsExclude", "asns", "asnsExclude"])}
    </FilterRail>
  )
}
