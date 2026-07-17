/**
 * Country / city / IP filter bar for the analytics page. Filters every chart
 * and top-list on the page via AnalyticsFiltersContext (not geo-time-series,
 * which stays unfiltered). Country/city options are lazy-loaded facets,
 * matching the pattern in access-logs-table.tsx.
 */
import { useState } from "react"
import { ChevronsUpDown, X } from "lucide-react"
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
import { useAccessLogFacets } from "@/lib/queries"
import { EMPTY_FILTERS, useAnalyticsFilters } from "@/lib/analytics-filters-context"

/** Light shape check, not a full validator - the backend 400s on truly invalid IPs. */
const IP_INPUT_RE = /^[0-9a-fA-F:.]+$/

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

export function AnalyticsFilterBar() {
  const { filters, setFilters } = useAnalyticsFilters()
  const [ipInput, setIpInput] = useState("")
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })

  const hasActiveFilters =
    filters.countryCodes.length > 0 || filters.cities.length > 0 || filters.ips.length > 0

  function toggleCountry(code: string) {
    setFilters((prev) => ({ ...prev, countryCodes: toggleValue(prev.countryCodes, code) }))
  }

  function toggleCity(city: string) {
    setFilters((prev) => ({ ...prev, cities: toggleValue(prev.cities, city) }))
  }

  function addIp() {
    const value = ipInput.trim()
    if (!value || !IP_INPUT_RE.test(value) || filters.ips.includes(value)) return
    setFilters((prev) => ({ ...prev, ips: [...prev.ips, value] }))
    setIpInput("")
  }

  function removeIp(ip: string) {
    setFilters((prev) => ({ ...prev, ips: prev.ips.filter((v) => v !== ip) }))
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
              onCheckedChange={() => toggleCountry(c.code)}
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
              onCheckedChange={() => toggleCity(city)}
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

      <Input
        value={ipInput}
        onChange={(e) => setIpInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            addIp()
          }
        }}
        placeholder="Add IP + Enter"
        aria-invalid={ipInput !== "" && !IP_INPUT_RE.test(ipInput)}
        className="h-8 w-40 font-mono text-xs"
      />

      {filters.ips.map((ip) => (
        <Badge key={ip} variant="secondary" className="font-mono">
          {ip}
          <button
            type="button"
            onClick={() => removeIp(ip)}
            aria-label={`Remove ${ip}`}
            className="ml-1 rounded-full hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => setFilters(EMPTY_FILTERS)}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
