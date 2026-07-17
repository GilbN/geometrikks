/**
 * Filter bar for the geo-logs page: country / city / hostname multiselects
 * (lazy-loaded facets) plus IP include and IP exclude inputs with chips.
 * Everything on the page (map, stats, chart, top lists, table) reshapes
 * through GeoLogFiltersContext, whose state lives in the URL search params.
 */
import { useState } from "react"
import { Ban, ChevronsUpDown, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGeoEventFacets } from "@/lib/queries"
import {
  EMPTY_GEO_LOG_FILTERS,
  hasActiveGeoLogFilters,
  useGeoLogFilters,
  type GeoLogFilterState,
} from "@/lib/geo-log-filters-context"

/** Light shape check, not a full validator - the backend 400s on truly invalid IPs. */
const IP_INPUT_RE = /^[0-9a-fA-F:.]+$/

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

export function GeoLogsFilterBar() {
  const { filters, setFilters } = useGeoLogFilters()
  const [ipInput, setIpInput] = useState("")
  const [ipExcludeInput, setIpExcludeInput] = useState("")
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useGeoEventFacets({ enabled: facetsEnabled })

  function toggleList(key: keyof GeoLogFilterState, value: string) {
    setFilters((prev) => ({ ...prev, [key]: toggleValue(prev[key], value) }))
  }

  function addIp(key: "ips" | "ipsExclude") {
    const input = key === "ips" ? ipInput : ipExcludeInput
    const setInput = key === "ips" ? setIpInput : setIpExcludeInput
    const value = input.trim()
    if (!value || !IP_INPUT_RE.test(value) || filters[key].includes(value)) return
    setFilters((prev) => ({ ...prev, [key]: [...prev[key], value] }))
    setInput("")
  }

  function removeIp(key: "ips" | "ipsExclude", ip: string) {
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu onOpenChange={(open) => open && setFacetsEnabled(true)}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            Country{filters.countryCodes.length > 0 && ` (${filters.countryCodes.length})`}
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-auto min-w-44 overflow-y-auto">
          <DropdownMenuLabel>Country</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {!facets && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">Loading…</DropdownMenuLabel>
          )}
          {facets?.countries.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.code}
              checked={filters.countryCodes.includes(c.code)}
              onCheckedChange={() => toggleList("countryCodes", c.code)}
              onSelect={(e) => e.preventDefault()}
            >
              {c.name} ({c.code})
            </DropdownMenuCheckboxItem>
          ))}
          {facets && facets.countries.length === 0 && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">No geo data</DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu onOpenChange={(open) => open && setFacetsEnabled(true)}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            City{filters.cities.length > 0 && ` (${filters.cities.length})`}
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-auto min-w-44 overflow-y-auto">
          <DropdownMenuLabel>City</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {!facets && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">Loading…</DropdownMenuLabel>
          )}
          {facets?.cities.map((city) => (
            <DropdownMenuCheckboxItem
              key={city}
              checked={filters.cities.includes(city)}
              onCheckedChange={() => toggleList("cities", city)}
              onSelect={(e) => e.preventDefault()}
            >
              {city}
            </DropdownMenuCheckboxItem>
          ))}
          {facets && facets.cities.length === 0 && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">No geo data</DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu onOpenChange={(open) => open && setFacetsEnabled(true)}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            Hostname{filters.hostnames.length > 0 && ` (${filters.hostnames.length})`}
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-auto min-w-44 overflow-y-auto">
          <DropdownMenuLabel>Recording hostname</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {!facets && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">Loading…</DropdownMenuLabel>
          )}
          {facets?.hostnames.map((host) => (
            <DropdownMenuCheckboxItem
              key={host}
              checked={filters.hostnames.includes(host)}
              onCheckedChange={() => toggleList("hostnames", host)}
              onSelect={(e) => e.preventDefault()}
            >
              {host}
            </DropdownMenuCheckboxItem>
          ))}
          {facets && facets.hostnames.length === 0 && (
            <DropdownMenuLabel className="font-normal text-muted-foreground">No hostnames</DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
        aria-invalid={ipInput !== "" && !IP_INPUT_RE.test(ipInput)}
        className="h-8 w-40 font-mono text-xs"
      />

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
        aria-invalid={ipExcludeInput !== "" && !IP_INPUT_RE.test(ipExcludeInput)}
        className="h-8 w-40 font-mono text-xs"
      />

      {filters.ips.map((ip) => (
        <Badge key={ip} variant="secondary" className="font-mono">
          {ip}
          <button
            type="button"
            onClick={() => removeIp("ips", ip)}
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
            onClick={() => removeIp("ipsExclude", ip)}
            aria-label={`Remove exclusion ${ip}`}
            className="ml-1 rounded-full hover:opacity-70"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {hasActiveGeoLogFilters(filters) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => setFilters(() => EMPTY_GEO_LOG_FILTERS)}
        >
          Clear filters
        </Button>
      )}
    </div>
  )
}
