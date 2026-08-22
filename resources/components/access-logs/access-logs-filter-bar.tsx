/**
 * Filter controls for the access-logs history table: search, IP, host,
 * hostname, source format, status, method, country and city. Renders in a
 * FilterRail on desktop and inside a FiltersDrawer on mobile. State lives in the URL via
 * AccessLogFiltersContext, so every control is a controlled input over the
 * route's search params.
 */
import { useEffect, useRef, useState } from "react"
import { Ban, Search, X } from "lucide-react"
import { FilterRail } from "@/components/data/filter-rail"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { FiltersDrawer, FilterSection } from "@/components/ui/filters-drawer"
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

  const [ipInput, setIpInput] = useState("")
  const [ipExcludeInput, setIpExcludeInput] = useState("")
  const [hostExcludeInput, setHostExcludeInput] = useState("")
  const [hostnameExcludeInput, setHostnameExcludeInput] = useState("")

  function addIp(key: "ips" | "ipsExclude") {
    const input = key === "ips" ? ipInput : ipExcludeInput
    const setInput = key === "ips" ? setIpInput : setIpExcludeInput
    const value = input.trim()
    // ip_address is INET server-side: only complete IPs can match, and the
    // backend 400s on anything else.
    if (!value || !isValidIp(value) || filters[key].includes(value)) return
    setFilters((prev) => ({ ...prev, [key]: [...prev[key], value] }))
    setInput("")
  }

  function addHostExclude() {
    const value = hostExcludeInput.trim()
    if (!value || filters.hostsExclude.includes(value)) return
    setFilters((prev) => ({ ...prev, hostsExclude: [...prev.hostsExclude, value] }))
    setHostExcludeInput("")
  }

  function addHostnameExclude() {
    const value = hostnameExcludeInput.trim()
    if (!value || filters.hostnamesExclude.includes(value)) return
    setFilters((prev) => ({ ...prev, hostnamesExclude: [...prev.hostnamesExclude, value] }))
    setHostnameExcludeInput("")
  }

  function removeFrom(
    key: "ips" | "ipsExclude" | "hostsExclude" | "hostnamesExclude",
    value: string,
  ) {
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== value) }))
  }

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
          "IP address",
          <Input
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addIp("ips")
              }
            }}
            placeholder="Add IP + Enter"
            aria-invalid={ipInput !== "" && !isValidIp(ipInput)}
            className={cn("h-8 font-mono text-xs", inDrawer ? "w-full" : "w-40")}
          />,
        )}
        {wrap(
          "Exclude IP",
          <Input
            value={ipExcludeInput}
            onChange={(e) => setIpExcludeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addIp("ipsExclude")
              }
            }}
            placeholder="Exclude IP + Enter"
            aria-invalid={ipExcludeInput !== "" && !isValidIp(ipExcludeInput)}
            className={cn("h-8 font-mono text-xs", inDrawer ? "w-full" : "w-40")}
          />,
        )}
        {wrap(
          "Host",
          <FilterCombobox
            label="Host"
            options={facets?.hosts ?? []}
            selected={filters.hosts}
            onChange={(values) => setFilters((prev) => ({ ...prev, hosts: values }))}
            loading={!facets}
            emptyText="No hosts"
            onOpenChange={(open) => open && setFacetsEnabled(true)}
            forceInline={inDrawer}
          />,
        )}
        {wrap(
          "Exclude host",
          <Input
            value={hostExcludeInput}
            onChange={(e) => setHostExcludeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addHostExclude()
              }
            }}
            placeholder="Exclude host + Enter"
            className={cn("h-8 font-mono text-xs", inDrawer ? "w-full" : "w-44")}
          />,
        )}
        {wrap(
          "Hostname",
          <FilterCombobox
            label="Hostname"
            options={facets?.hostnames ?? []}
            selected={filters.hostnames}
            onChange={(values) => setFilters((prev) => ({ ...prev, hostnames: values }))}
            loading={!facets}
            emptyText="No hostnames"
            onOpenChange={(open) => open && setFacetsEnabled(true)}
            forceInline={inDrawer}
          />,
        )}
        {wrap(
          "Exclude hostname",
          <Input
            value={hostnameExcludeInput}
            onChange={(e) => setHostnameExcludeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addHostnameExclude()
              }
            }}
            placeholder="Exclude hostname + Enter"
            className={cn("h-8 font-mono text-xs", inDrawer ? "w-full" : "w-44")}
          />,
        )}
        {wrap(
          "Source format",
          <FilterCombobox
            label="Source format"
            options={facets?.logFormats ?? []}
            selected={filters.logFormats}
            onChange={(values) => setFilters((prev) => ({ ...prev, logFormats: values }))}
            loading={!facets}
            emptyText="No formats"
            onOpenChange={(open) => open && setFacetsEnabled(true)}
            forceInline={inDrawer}
          />,
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

        {filters.ips.map((ip) => (
          <Badge key={ip} variant="secondary" className="font-mono">
            {ip}
            <button
              type="button"
              onClick={() => removeFrom("ips", ip)}
              aria-label={`Remove ${ip}`}
              className="ml-1 rounded-full hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        {filters.ipsExclude.map((ip) => (
          <Badge
            key={ip}
            variant="outline"
            className="border-destructive/50 font-mono text-destructive"
          >
            <Ban className="h-3 w-3" />
            {ip}
            <button
              type="button"
              onClick={() => removeFrom("ipsExclude", ip)}
              aria-label={`Remove exclusion ${ip}`}
              className="ml-1 rounded-full hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        {filters.hostsExclude.map((host) => (
          <Badge
            key={host}
            variant="outline"
            className="border-destructive/50 font-mono text-destructive"
          >
            <Ban className="h-3 w-3" />
            {host}
            <button
              type="button"
              onClick={() => removeFrom("hostsExclude", host)}
              aria-label={`Remove exclusion ${host}`}
              className="ml-1 rounded-full hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        {filters.hostnamesExclude.map((hostname) => (
          <Badge
            key={hostname}
            variant="outline"
            className="border-destructive/50 font-mono text-destructive"
          >
            <Ban className="h-3 w-3" />
            {hostname}
            <button
              type="button"
              onClick={() => removeFrom("hostnamesExclude", hostname)}
              aria-label={`Remove exclusion ${hostname}`}
              className="ml-1 rounded-full hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </>
    )
  }

  const activeCount = countActiveAccessLogFilters(filters)
  const clear = () => {
    setSearchInput("")
    setFilters(() => EMPTY_ACCESS_LOG_FILTERS)
  }

  if (isMobile) {
    return (
      <div onClick={() => setFacetsEnabled(true)}>
        <FiltersDrawer activeCount={activeCount} onClear={clear}>
          {renderFilters(true)}
        </FiltersDrawer>
      </div>
    )
  }

  return (
    <FilterRail label="Request filters" activeCount={activeCount} onClear={clear}>
      {renderFilters(false)}
    </FilterRail>
  )
}
