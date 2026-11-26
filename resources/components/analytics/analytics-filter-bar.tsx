/**
 * IP / host / country / city / ASN filter bar for the analytics page. Filters
 * every chart and top-list on the page via AnalyticsFiltersContext (not
 * geo-time-series, which stays unfiltered). Host/country/city/ASN options are
 * lazy-loaded facets.
 * Renders as a FilterBar on desktop and inside a FiltersDrawer on phones.
 */
import { CountryFlag } from "@/components/country-flag"
import { useState } from "react"
import { Flag, Globe, Hash, MapPin, Network } from "lucide-react"
import { FilterBar } from "@/components/data/filter-bar"
import { listField, typedField, type FilterBarField } from "@/components/data/filter-bar-fields"
import { FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import type { PickedValue } from "@/components/command-palette/filter-value-results"
import { countryDisplayName } from "@/lib/country-flags"
import {
  FilterExcludedIpRows,
  FilterListRow,
  FilterMutedIpsRow,
  FilterSection,
} from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAsnLabel } from "@/hooks/use-asn-label"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useAccessLogFacets } from "@/lib/queries"
import { mutedDrawerCounts } from "@/lib/muted-ips"
import { ipFilterHint, isValidIpFilter } from "@/lib/ip-filter-values"
import {
  countActiveAnalyticsFilters,
  EMPTY_FILTERS,
  useAnalyticsFilters,
} from "@/lib/analytics-filters-context"

type IpKey = "ips" | "ipsExclude"
type HostKey = "hosts" | "hostsExclude"
type AsnKey = "asns" | "asnsExclude"

export function AnalyticsFilterBar() {
  const phone = usePhoneLayout()
  const { filters, setFilters, muted, toggleMuted } = useAnalyticsFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  // Selected ASNs need the facets for their organization labels, and selected
  // hosts for their options.
  const { data: facets } = useAccessLogFacets({
    enabled:
      facetsEnabled ||
      filters.asns.length > 0 ||
      filters.asnsExclude.length > 0 ||
      filters.hosts.length > 0 ||
      filters.hostsExclude.length > 0,
  })
  // A host from a shared link may be missing from the facets; it still needs
  // an option so it can be unselected.
  const hostOptions = [
    ...new Set([...(facets?.hosts ?? []), ...filters.hosts, ...filters.hostsExclude]),
  ]
  const asnLabel = useAsnLabel(facets?.asns)
  const countryName = (code: string) => facets?.countries.find((c) => c.code === code)?.name
  const countryLabel = (code: string) => {
    const name = countryName(code)
    return name ? `${name} (${code})` : code
  }

  const addIp = (key: IpKey) => (value: string) => {
    if (filters[key].includes(value)) return
    setFilters((prev) => ({ ...prev, [key]: [...prev[key], value] }))
  }
  const removeIp = (key: IpKey, ip: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))
  const setHosts = (key: HostKey) => (values: string[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }))
  const removeHostExclude = (host: string) =>
    setFilters((prev) => ({ ...prev, hostsExclude: prev.hostsExclude.filter((v) => v !== host) }))
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
    ...filters.hostsExclude.map((v) => ({
      key: "hostsExclude" as const,
      label: v,
      exclude: true,
      remove: () => removeHostExclude(v),
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
  const chipRow = (keys: (IpKey | "hostsExclude" | AsnKey)[]) => {
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

  const urlCount = countActiveAnalyticsFilters(filters)
  const { activeCount, clearCount } = mutedDrawerCounts(urlCount, muted.flag)
  const clear = () => setFilters(() => EMPTY_FILTERS)

  if (phone) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
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
              label="Host"
              search
              options={hostOptions}
              selected={filters.hosts}
              onChange={setHosts("hosts")}
              loading={!facets}
              emptyText="No hosts"
            />
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
            <FilterMutedIpsRow scope={muted} onToggle={toggleMuted} />
            <FilterExcludedIpRows
              values={filters.ipsExclude}
              onAdd={addIp("ipsExclude")}
              onRemove={(ip) => removeIp("ipsExclude", ip)}
              validate={isValidIpFilter}
              hint={ipFilterHint}
            />
            <FilterListRow
              label="Host"
              exclude
              search
              options={hostOptions}
              selected={filters.hostsExclude}
              onChange={setHosts("hostsExclude")}
              loading={!facets}
              emptyText="No hosts"
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

  const onPick = (picked: PickedValue) =>
    setFilters((prev) => {
      const add = <T,>(list: T[], value: T) => (list.includes(value) ? list : [...list, value])
      const drop = <T,>(list: T[], value: T) => list.filter((entry) => entry !== value)
      switch (picked.kind) {
        case "country":
          return { ...prev, countryCodes: add(prev.countryCodes, picked.code) }
        case "city":
          return { ...prev, cities: add(prev.cities, picked.city) }
        case "host":
          return {
            ...prev,
            hosts: add(prev.hosts, picked.host),
            hostsExclude: drop(prev.hostsExclude, picked.host),
          }
        case "asn":
          return {
            ...prev,
            asns: add(prev.asns, picked.asn),
            asnsExclude: drop(prev.asnsExclude, picked.asn),
          }
        case "server":
          return prev
      }
    })

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
      id: "host",
      label: "Host",
      icon: Globe,
      include: filters.hosts,
      exclude: filters.hostsExclude,
      onChange: (hosts, hostsExclude) => setFilters((prev) => ({ ...prev, hosts, hostsExclude })),
      labelFor: String,
      mono: true,
      options: hostOptions,
      loading: !facets,
      emptyText: "No hosts",
      onOpen: loadFacets,
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
      label="Traffic filters"
      pageId="analytics"
      fields={fields}
      activeCount={urlCount}
      onClear={clear}
      muted={muted}
      onToggleMuted={toggleMuted}
      valueSearch={{ onPick, kinds: ["country", "city", "host", "asn"] }}
    />
  )
}
