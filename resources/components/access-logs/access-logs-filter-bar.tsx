/**
 * Filter controls for the access-logs history table. Renders in a FilterRail
 * on desktop (text inputs on one row, selects on the next) and as a flat list
 * inside a FiltersDrawer on phones. State
 * lives in the URL via AccessLogFiltersContext, so every control is a
 * controlled input over the route's search params.
 */
import { CountryFlag } from "@/components/country-flag"
import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { FilterField, FilterPair, FilterRail, FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FilterExcludedIpRows, FilterListRow, FilterSection } from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAccessLogFacets } from "@/lib/queries"
import { useAsnLabel } from "@/hooks/use-asn-label"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { isValidIp } from "@/lib/crowdsec"
import { HTTP_METHODS } from "@/lib/http-methods"
import {
  countActiveAccessLogFilters,
  EMPTY_ACCESS_LOG_FILTERS,
  useAccessLogFilters,
} from "@/lib/access-log-filters-context"

const STATUS_CODES = [
  100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
  300, 301, 302, 303, 304, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426,
  428, 429, 431, 444, 451, 499,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
] as const

type ListKey = "ips" | "ipsExclude" | "hostsExclude" | "serversExclude"
type AsnKey = "asns" | "asnsExclude"

export function AccessLogsFilterBar() {
  const phone = usePhoneLayout()
  const { filters, setFilters } = useAccessLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  // Selected ASNs need the facets for their organization labels.
  const { data: facets } = useAccessLogFacets({
    enabled: facetsEnabled || filters.asns.length > 0 || filters.asnsExclude.length > 0,
  })
  const asnLabel = useAsnLabel(facets?.asns)
  const countryName = (code: string) => facets?.countries.find((c) => c.code === code)?.name
  const countryLabel = (code: string) => {
    const name = countryName(code)
    return name ? `${name} (${code})` : code
  }

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
  const setAsns = (key: AsnKey) => (values: number[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }))
  const removeAsn = (key: AsnKey, asn: number) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== asn) }))

  const textChip = (key: ListKey, exclude: boolean) => (v: string) => ({
    key, label: v, exclude, remove: () => remove(key, v),
  })
  const asnChip = (key: AsnKey, exclude: boolean) => (v: number) => ({
    key, label: asnLabel(v), exclude, remove: () => removeAsn(key, v),
  })
  const chips = [
    ...filters.ips.map(textChip("ips", false)),
    ...filters.ipsExclude.map(textChip("ipsExclude", true)),
    ...filters.hostsExclude.map(textChip("hostsExclude", true)),
    ...filters.serversExclude.map(textChip("serversExclude", true)),
    ...filters.asns.map(asnChip("asns", false)),
    ...filters.asnsExclude.map(asnChip("asnsExclude", true)),
  ]
  const chipRow = (keys: (ListKey | AsnKey)[]) => {
    const shown = chips.filter((c) => keys.includes(c.key))
    return shown.length > 0 && (
      <FilterRow>
        {shown.map((c) => (
          <FilterChip key={`${c.key}:${c.label}`} value={c.label} exclude={c.exclude} onRemove={c.remove} />
        ))}
      </FilterRow>
    )
  }

  const search = () => (
    <FilterField label="Search">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="URL, referrer or user agent"
          className="h-8 pl-7 text-xs w-64"
        />
      </div>
    </FilterField>
  )
  const ipPair = () => (
    <FilterPair
      label="IP address"
      excludeLabel="Exclude IP"
      include={
        <TagInput
          onAdd={add("ips")}
          validate={isValidIp}
          placeholder="203.0.113.7"
          className="w-36"
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("ipsExclude")}
          validate={isValidIp}
          placeholder="Exclude"
          className="w-32"
        />
      }
    />
  )
  const hostPair = () => (
    <FilterPair
      label="Host"
      excludeLabel="Exclude host"
      include={
        <FilterCombobox
          label="Host"
          options={facets?.hosts ?? []}
          selected={filters.hosts}
          onChange={(values) => setFilters((prev) => ({ ...prev, hosts: values }))}
          loading={!facets}
          emptyText="No hosts"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("hostsExclude")}
          placeholder="Exclude"
          className="w-36"
        />
      }
    />
  )
  const serverPair = () => (
    <FilterPair
      label="Server"
      excludeLabel="Exclude server"
      include={
        <FilterCombobox
          label="Server"
          options={facets?.servers ?? []}
          selected={filters.servers}
          onChange={(values) => setFilters((prev) => ({ ...prev, servers: values }))}
          loading={!facets}
          emptyText="No servers"
          onOpenChange={(open) => open && setFacetsEnabled(true)}
        />
      }
      exclude={
        <TagInput
          exclude
          onAdd={add("serversExclude")}
          placeholder="Exclude"
          className="w-36"
        />
      }
    />
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
  const method = () => (
    <FilterField label="Method" hideLabel>
      <FilterCombobox
        label="Method"
        options={[...HTTP_METHODS]}
        selected={filters.methods}
        onChange={(values) => setFilters((prev) => ({ ...prev, methods: values }))}
      />
    </FilterField>
  )
  const status = () => (
    <FilterField label="Status" hideLabel>
      <FilterCombobox
        label="Status"
        options={[...STATUS_CODES]}
        selected={filters.statusCodes}
        onChange={(values) => setFilters((prev) => ({ ...prev, statusCodes: values }))}
      />
    </FilterField>
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
  const logFormat = () => (
    <FilterField label="Source format" hideLabel>
      <FilterCombobox
        label="Source format"
        options={facets?.logFormats ?? []}
        selected={filters.logFormats}
        onChange={(values) => setFilters((prev) => ({ ...prev, logFormats: values }))}
        loading={!facets}
        emptyText="No formats"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
      />
    </FilterField>
  )

  const activeCount = countActiveAccessLogFilters(filters)
  const clear = () => {
    setSearchInput("")
    setFilters(() => EMPTY_ACCESS_LOG_FILTERS)
  }

  if (phone) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search"
            placeholder="URL, referrer or user agent"
            className="h-10 w-full"
          />
          <TagInput
            onAdd={add("ips")}
            validate={isValidIp}
            placeholder="203.0.113.7"
            aria-label="IP address"
            className="w-full"
            inputClassName="h-10"
          />
          {chipRow(["ips"])}
          <FilterSection label="Show only">
            <FilterListRow
              label="Host"
              options={facets?.hosts ?? []}
              selected={filters.hosts}
              onChange={(values) => setFilters((prev) => ({ ...prev, hosts: values }))}
              loading={!facets}
              emptyText="No hosts"
            />
            <FilterListRow
              label="Server"
              options={facets?.servers ?? []}
              selected={filters.servers}
              onChange={(values) => setFilters((prev) => ({ ...prev, servers: values }))}
              loading={!facets}
            />
            <FilterListRow
              label="Method"
              options={[...HTTP_METHODS]}
              selected={filters.methods}
              onChange={(values) => setFilters((prev) => ({ ...prev, methods: values }))}
            />
            <FilterListRow
              label="Status"
              options={[...STATUS_CODES]}
              selected={filters.statusCodes}
              onChange={(values) => setFilters((prev) => ({ ...prev, statusCodes: values }))}
            />
            <FilterListRow
              label="Source format"
              options={facets?.logFormats ?? []}
              selected={filters.logFormats}
              onChange={(values) => setFilters((prev) => ({ ...prev, logFormats: values }))}
              loading={!facets}
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
            <FilterExcludedIpRows values={filters.ipsExclude} onAdd={add("ipsExclude")} onRemove={(ip) => remove("ipsExclude", ip)} validate={isValidIp} />
            <FilterListRow
              label="Host" exclude
              options={facets?.hosts ?? []}
              selected={filters.hostsExclude}
              onChange={(values) => setFilters((prev) => ({ ...prev, hostsExclude: values }))}
              loading={!facets}
            />
            <FilterListRow
              label="Server" exclude
              options={facets?.servers ?? []}
              selected={filters.serversExclude}
              onChange={(values) => setFilters((prev) => ({ ...prev, serversExclude: values }))}
              loading={!facets}
            />
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
    <FilterRail label="Request filters" activeCount={activeCount} onClear={clear}>
      <FilterRow>
        {search()}
        {ipPair()}
        {hostPair()}
        {serverPair()}
      </FilterRow>
      <FilterRow>
        {method()}
        {status()}
        {logFormat()}
        {country()}
        {city()}
        {asnPair()}
      </FilterRow>
      {chipRow(["ips", "ipsExclude", "hostsExclude", "serversExclude", "asns", "asnsExclude"])}
    </FilterRail>
  )
}
