/**
 * Filter controls for the access-logs history table. Renders as a FilterBar
 * on desktop (one line of chips with a Filter menu) and as a flat list
 * inside a FiltersDrawer on phones. State
 * lives in the URL via AccessLogFiltersContext, so every control is a
 * controlled input over the route's search params.
 */
import { CountryFlag } from "@/components/country-flag"
import { useEffect, useRef, useState } from "react"
import {
  Activity,
  ArrowRight,
  FileText,
  Flag,
  Globe,
  Hash,
  MapPin,
  Network,
  Search,
  Server,
} from "lucide-react"
import { ExcludeMyIpButton } from "@/components/data/exclude-my-ip"
import { FilterBar } from "@/components/data/filter-bar"
import { listField, typedField, type FilterBarField } from "@/components/data/filter-bar-fields"
import { FilterRow } from "@/components/data/filter-rail"
import { FilterChip, TagInput } from "@/components/data/tag-input"
import { Input } from "@/components/ui/input"
import type { PickedValue } from "@/components/command-palette/filter-value-results"
import {
  FilterExcludedIpRows,
  FilterListRow,
  FilterMutedIpsRow,
  FilterMyIpRow,
  FilterSection,
} from "@/components/ui/filter-rows"
import { FiltersDrawer } from "@/components/ui/filters-drawer"
import { useAccessLogFacets } from "@/lib/queries"
import { useAsnLabel } from "@/hooks/use-asn-label"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useMyIpExclusion } from "@/hooks/use-my-ip-exclusion"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { mutedDrawerCounts } from "@/lib/muted-ips"
import { ipFilterHint, isValidIpFilter } from "@/lib/ip-filter-values"
import { countryDisplayName } from "@/lib/country-flags"
import { HTTP_METHODS } from "@/lib/http-methods"
import {
  countActiveAccessLogFilters,
  EMPTY_ACCESS_LOG_FILTERS,
  useAccessLogFilters,
} from "@/lib/access-log-filters-context"

const STATUS_CODES = [
  100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304,
  305, 306, 307, 308, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
  415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 444, 451, 499, 500, 501, 502,
  503, 504, 505, 506, 507, 508, 510, 511,
] as const

type ListKey = "ips" | "ipsExclude" | "hostsExclude" | "serversExclude"
type AsnKey = "asns" | "asnsExclude"

const IP_HELP = "Takes an address or a CIDR range."

/** `leading` goes first in the desktop bar, such as the page's tabs. */
export function AccessLogsFilterBar({ leading }: { leading?: React.ReactNode }) {
  const phone = usePhoneLayout()
  const { filters, setFilters, muted, toggleMuted } = useAccessLogFilters()
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  // Selected ASNs need the facets for their organization labels.
  const { data: facets } = useAccessLogFacets({
    enabled: facetsEnabled || filters.asns.length > 0 || filters.asnsExclude.length > 0,
  })
  const asnLabel = useAsnLabel(facets?.asns)
  // The browser names a country until the facets arrive, as on a shared link.
  const countryName = (code: string) =>
    facets?.countries.find((c) => c.code === code)?.name ?? countryDisplayName(code)
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
    // A tap on Exclude your IP lands after a lookup, so the closure can be stale.
    setFilters((prev) =>
      prev[key].includes(value) ? prev : { ...prev, [key]: [...prev[key], value] },
    )
  }
  const remove = (key: ListKey, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== value) }))
  const myIp = useMyIpExclusion(filters.ipsExclude, add("ipsExclude"), (ip) =>
    remove("ipsExclude", ip),
  )
  const setAsns = (key: AsnKey) => (values: number[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }))
  const removeAsn = (key: AsnKey, asn: number) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== asn) }))

  const textChip = (key: ListKey, exclude: boolean) => (v: string) => ({
    key,
    label: v,
    exclude,
    remove: () => remove(key, v),
  })
  const asnChip = (key: AsnKey, exclude: boolean) => (v: number) => ({
    key,
    label: asnLabel(v),
    exclude,
    remove: () => removeAsn(key, v),
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

  const urlCount = countActiveAccessLogFilters(filters)
  const { activeCount, clearCount } = mutedDrawerCounts(urlCount, muted.flag)
  const clear = () => {
    setSearchInput("")
    setFilters(() => EMPTY_ACCESS_LOG_FILTERS)
  }

  if (phone) {
    return (
      <div className="flex items-center gap-2" onClick={() => setFacetsEnabled(true)}>
        <ExcludeMyIpButton exclusion={myIp} />
        <FiltersDrawer activeCount={activeCount} clearCount={clearCount} onClear={clear}>
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search"
            placeholder="URL, referrer or user agent"
            className="h-10 w-full"
          />
          <TagInput
            onAdd={add("ips")}
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
            <FilterMyIpRow exclusion={myIp} />
            <FilterMutedIpsRow scope={muted} onToggle={toggleMuted} />
            <FilterExcludedIpRows
              values={filters.ipsExclude}
              onAdd={add("ipsExclude")}
              onRemove={(ip) => remove("ipsExclude", ip)}
              validate={isValidIpFilter}
              hint={ipFilterHint}
            />
            <FilterListRow
              label="Host"
              exclude
              search
              options={facets?.hosts ?? []}
              selected={filters.hostsExclude}
              onChange={(values) => setFilters((prev) => ({ ...prev, hostsExclude: values }))}
              loading={!facets}
            />
            <FilterListRow
              label="Server"
              exclude
              options={facets?.servers ?? []}
              selected={filters.serversExclude}
              onChange={(values) => setFilters((prev) => ({ ...prev, serversExclude: values }))}
              loading={!facets}
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
        case "server":
          return {
            ...prev,
            servers: add(prev.servers, picked.server),
            serversExclude: drop(prev.serversExclude, picked.server),
          }
        case "asn":
          return {
            ...prev,
            asns: add(prev.asns, picked.asn),
            asnsExclude: drop(prev.asnsExclude, picked.asn),
          }
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
      help: IP_HELP,
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
      options: facets?.hosts ?? [],
      loading: !facets,
      emptyText: "No hosts",
      onOpen: loadFacets,
    }),

    listField({
      id: "server",
      label: "Server",
      icon: Server,
      include: filters.servers,
      exclude: filters.serversExclude,
      onChange: (servers, serversExclude) =>
        setFilters((prev) => ({ ...prev, servers, serversExclude })),
      labelFor: String,
      options: facets?.servers ?? [],
      loading: !facets,
      emptyText: "No servers",
      onOpen: loadFacets,
    }),

    listField({
      id: "method",
      label: "Method",
      icon: ArrowRight,
      include: filters.methods,
      onChange: (methods) => setFilters((prev) => ({ ...prev, methods })),
      labelFor: String,
      chipValues: 3,
      options: [...HTTP_METHODS],
    }),

    listField({
      id: "status",
      label: "Status",
      icon: Activity,
      include: filters.statusCodes,
      onChange: (statusCodes) => setFilters((prev) => ({ ...prev, statusCodes })),
      labelFor: String,
      chipValues: 3,
      options: [...STATUS_CODES],
    }),

    listField({
      id: "format",
      label: "Source format",
      icon: FileText,
      include: filters.logFormats,
      onChange: (logFormats) => setFilters((prev) => ({ ...prev, logFormats })),
      labelFor: String,
      options: facets?.logFormats ?? [],
      loading: !facets,
      emptyText: "No formats",
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
          {countryName(code) ?? code}
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
      label="Request filters"
      pageId="access-logs"
      leading={leading}
      search={
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search"
            placeholder="URL, referrer or user agent"
            className="h-8 w-[214px] pl-8 md:text-[13px]"
            data-page-filter=""
          />
        </div>
      }
      fields={fields}
      activeCount={urlCount}
      onClear={clear}
      myIp={myIp}
      muted={muted}
      onToggleMuted={toggleMuted}
      valueSearch={{ onPick }}
    />
  )
}
