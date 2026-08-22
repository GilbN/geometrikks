/**
 * Shared filters for the geo-logs page (country/city/IP include/IP exclude/
 * hostname). Unlike the analytics filters, the state itself lives in the URL
 * search params (shareable filter links): the /geo-logs route computes the
 * filter state from its validated search and implements setFilters via
 * router.navigate, then mounts this provider as a plain conduit.
 */
import { createContext, useContext } from "react"

export interface GeoLogFilterState {
  countryCodes: string[]
  cities: string[]
  ips: string[]
  ipsExclude: string[]
  hostnames: string[]
}

export const EMPTY_GEO_LOG_FILTERS: GeoLogFilterState = {
  countryCodes: [],
  cities: [],
  ips: [],
  ipsExclude: [],
  hostnames: [],
}

/** How many filter groups are set; a multi-select counts once however
 * many values it holds. Drives the rail badge and the mobile drawer count. */
export function countActiveGeoLogFilters(filters: GeoLogFilterState): number {
  return (
    (filters.countryCodes.length ? 1 : 0) +
    (filters.cities.length ? 1 : 0) +
    (filters.ips.length ? 1 : 0) +
    (filters.ipsExclude.length ? 1 : 0) +
    (filters.hostnames.length ? 1 : 0)
  )
}

export function hasActiveGeoLogFilters(filters: GeoLogFilterState): boolean {
  return countActiveGeoLogFilters(filters) > 0
}

interface GeoLogFiltersValue {
  filters: GeoLogFilterState
  setFilters: (updater: (prev: GeoLogFilterState) => GeoLogFilterState) => void
}

// Default = empty filters: hooks keep working outside the provider.
const GeoLogFiltersContext = createContext<GeoLogFiltersValue>({
  filters: EMPTY_GEO_LOG_FILTERS,
  setFilters: () => {},
})

export function GeoLogFiltersProvider({
  filters,
  setFilters,
  children,
}: GeoLogFiltersValue & { children: React.ReactNode }) {
  return (
    <GeoLogFiltersContext.Provider value={{ filters, setFilters }}>
      {children}
    </GeoLogFiltersContext.Provider>
  )
}

export function useGeoLogFilters() {
  return useContext(GeoLogFiltersContext)
}
