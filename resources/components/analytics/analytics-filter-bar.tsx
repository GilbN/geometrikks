/**
 * Country / city / IP filter bar for the analytics page. Filters every chart
 * and top-list on the page via AnalyticsFiltersContext (not geo-time-series,
 * which stays unfiltered). Country/city options are lazy-loaded facets,
 * matching the pattern in access-logs-table.tsx.
 */
import { useState } from "react"
import { Ban, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { useAccessLogFacets } from "@/lib/queries"
import { isValidIp } from "@/lib/crowdsec"
import {
  EMPTY_FILTERS,
  hasActiveAnalyticsFilters,
  useAnalyticsFilters,
} from "@/lib/analytics-filters-context"

export function AnalyticsFilterBar() {
  const { filters, setFilters } = useAnalyticsFilters()
  const [ipInput, setIpInput] = useState("")
  const [ipExcludeInput, setIpExcludeInput] = useState("")
  const [facetsEnabled, setFacetsEnabled] = useState(false)
  const { data: facets } = useAccessLogFacets({ enabled: facetsEnabled })

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

  function removeIp(key: "ips" | "ipsExclude", ip: string) {
    setFilters((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== ip) }))
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
            addIp("ips")
          }
        }}
        placeholder="Add IP + Enter"
        aria-invalid={ipInput !== "" && !isValidIp(ipInput)}
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
        className="h-8 w-40 font-mono text-xs"
      />

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

      {hasActiveAnalyticsFilters(filters) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 pointer-coarse:h-10"
          onClick={() => setFilters(() => EMPTY_FILTERS)}
        >
          Clear filters
        </Button>
      )}
    </div>
  )
}
