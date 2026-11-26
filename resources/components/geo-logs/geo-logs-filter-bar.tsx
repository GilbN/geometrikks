/**
 * Filter bar for the geo-logs page: IP include/exclude, country, city and
 * server multiselects, and an ASN include/exclude combobox pair
 * (lazy-loaded facets). Renders as a FilterBar on desktop and inside a
 * FiltersDrawer on phones. Everything on the page (map, stats, chart, top
 * lists, table) reshapes through GeoLogFiltersContext, whose state lives in
 * the URL search params.
 */
import { CountryFlag } from "@/components/country-flag"
import { useState } from "react"
import { Flag, Hash, MapPin, Network, Server } from "lucide-react"
import { ExcludeMyIpButton } from "@/components/data/exclude-my-ip"
import { FilterBar } from "@/components/data/filter-bar"
import { listField, typedField, type FilterBarField } from "@/components/data/filter-bar-fields"
import { FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import {
  FilterExcludedIpRows,
  FilterListRow,
  FilterMutedIpsRow,
  FilterMyIpRow,
  FilterSection,
} from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAsnLabel } from "@/hooks/use-asn-label"
import { useMyIpExclusion } from "@/hooks/use-my-ip-exclusion"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useGeoEventFacets } from "@/lib/queries"
import { mutedDrawerCounts } from "@/lib/muted-ips"
import { ipFilterHint, isValidIpFilter } from "@/lib/ip-filter-values"
import { countryDisplayName } from "@/lib/country-flags"
import {
  countActiveGeoLogFilters,
  EMPTY_GEO_LOG_FILTERS,
  useGeoLogFilters,
} from "@/lib/geo-log-filters-context"

type IpKey = "ips" | "ipsExclude"

export function GeoLogsFilterBar() {
  const phone = usePhoneLayout()
  const { filters, setFilters, muted, toggleMuted } = useGeoLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useGeoEventFacets({
    enabled: facetsEnabled || filters.asns.length > 0 || filters.asnsExclude.length > 0,
  })

  const addIp = (key: IpKey) => (value: string) => {
    if (filters[key].includes(value)) return
    // A tap on Exclude your IP lands after a lookup, so the closure can be stale.
    setFilters((prev) =>
      prev[key].includes(value) ? prev : { ...prev, [key]: [...prev[key], value] },
    )
  }
  const removeIp = (key: IpKey, ip: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))
  const myIp = useMyIpExclusion(filters.ipsExclude, addIp("ipsExclude"), (ip) =>
    removeIp("ipsExclude", ip),
  )

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
    ...filters.ips.map((v) => ({
      key: "ips" as const,
      label: v,
      exclude: false,
      remove: () => removeIp("ips", v),
    })),
    ...filters.ipsExclude.map((v) => ({
      key: "ipsExclude" as const,
      label: v,
      exclude: true,
      remove: () => removeIp("ipsExclude", v),
    })),
    ...filters.asns.map((v) => ({
      key: "asns" as const,
      label: asnLabel(v),
      exclude: false,
      remove: () => removeAsn("asns", v),
    })),
    ...filters.asnsExclude.map((v) => ({
      key: "asnsExclude" as const,
      label: asnLabel(v),
      exclude: true,
      remove: () => removeAsn("asnsExclude", v),
    })),
  ]
  const chipRow = (keys: (IpKey | AsnKey)[]) => {
    const shown = chips.filter((c) => keys.includes(c.key))
    return (
      shown.length > 0 && (
        <FilterRow>
          {shown.map((c) => (
            <FilterChip
              key={`${c.key}:${c.label}`}
              value={c.label}
              exclude={c.exclude}
              onRemove={c.remove}
            />
          ))}
        </FilterRow>
      )
    )
  }

  const urlCount = countActiveGeoLogFilters(filters)
  const { activeCount, clearCount } = mutedDrawerCounts(urlCount, muted.flag)
  const clear = () => setFilters(() => EMPTY_GEO_LOG_FILTERS)

  if (phone) {
    return (
      <div className="flex items-center gap-2" onClick={() => setFacetsEnabled(true)}>
        <ExcludeMyIpButton exclusion={myIp} />
        <FiltersDrawer activeCount={activeCount} clearCount={clearCount} onClear={clear}>
          <TagInput
            onAdd={addIp("ips")}
            validate={isValidIpFilter}
            hint={ipFilterHint}
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
            <FilterMutedIpsRow scope={muted} onToggle={toggleMuted} />
            <FilterExcludedIpRows
              values={filters.ipsExclude}
              onAdd={addIp("ipsExclude")}
              onRemove={(ip) => removeIp("ipsExclude", ip)}
              validate={isValidIpFilter}
              hint={ipFilterHint}
            />
            <FilterListRow<number>
              label="ASN"
              exclude
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

  const loadFacets = () => setFacetsEnabled(true)
  const fields: FilterBarField[] = [
    typedField({
      id: "ip",
      label: "IP address",
      chipLabel: "IP",
      icon: Hash,
      include: filters.ips,
      exclude: filters.ipsExclude,
      onChange: (ips, ipsExclude) => setFilters((prev) => ({ ...prev, ips, ipsExclude })),
      labelFor: String,
      mono: true,
      validate: isValidIpFilter,
      hint: ipFilterHint,
      placeholder: "203.0.113.7",
      help: "Takes an address or a CIDR range.",
    }),
    listField({
      id: "country",
      label: "Country",
      icon: Flag,
      include: filters.countryCodes,
      onChange: (countryCodes) => setFilters((prev) => ({ ...prev, countryCodes })),
      labelFor: countryLabel,
      chipValue: (code) => (
        <>
          <CountryFlag code={code} />
          {countryName(code) ?? countryDisplayName(code) ?? code}
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
      include: filters.cities,
      onChange: (cities) => setFilters((prev) => ({ ...prev, cities })),
      labelFor: String,
      options: facets?.cities ?? [],
      loading: !facets,
      emptyText: "No geo data",
      onOpen: loadFacets,
    }),
    listField({
      id: "server",
      label: "Server",
      icon: Server,
      include: filters.servers,
      onChange: (servers) => setFilters((prev) => ({ ...prev, servers })),
      labelFor: String,
      options: facets?.servers ?? [],
      loading: !facets,
      emptyText: "No servers",
      onOpen: loadFacets,
    }),
    listField({
      id: "asn",
      label: "ASN",
      icon: Network,
      include: filters.asns,
      exclude: filters.asnsExclude,
      onChange: (asns, asnsExclude) => setFilters((prev) => ({ ...prev, asns, asnsExclude })),
      labelFor: asnLabel,
      chipValue: (asn) => `AS${asn}`,
      options: facets?.asns.map((a) => a.asn) ?? [],
      loading: !facets,
      emptyText: "No ASN data",
      onOpen: loadFacets,
    }),
  ]

  return (
    <FilterBar
      label="Location filters"
      pageId="geo-logs"
      fields={fields}
      activeCount={urlCount}
      onClear={clear}
      myIp={myIp}
      muted={muted}
      onToggleMuted={toggleMuted}
    />
  )
}
