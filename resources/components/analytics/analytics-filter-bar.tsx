/**
 * Country / city / IP filter bar for the analytics page. Filters every chart
 * and top-list on the page via AnalyticsFiltersContext (not geo-time-series,
 * which stays unfiltered). Country/city options are lazy-loaded facets,
 * matching the pattern in access-logs-table.tsx.
 */
import { useState } from "react"
import { X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { useAccessLogFacets } from "@/lib/queries"
import { EMPTY_FILTERS, useAnalyticsFilters } from "@/lib/analytics-filters-context"

/** Light shape check, not a full validator - the backend 400s on truly invalid IPs. */
const IP_INPUT_RE = /^[0-9a-fA-F:.]+$/

export function AnalyticsFilterBar() {
  const { filters, setFilters } = useAnalyticsFilters()
  const [ipInput, setIpInput] = useState("")
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })

  const hasActiveFilters =
    filters.countryCodes.length > 0 || filters.cities.length > 0 || filters.ips.length > 0

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
      />

      <FilterCombobox
        label="City"
        options={facets?.cities ?? []}
        selected={filters.cities}
        onChange={(values) => setFilters((prev) => ({ ...prev, cities: values }))}
        loading={!facets}
        emptyText="No geo data"
        onOpenChange={(open) => open && setFacetsEnabled(true)}
      />

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
