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

export function hasActiveGeoLogFilters(filters: GeoLogFilterState): boolean {
  return (
    filters.countryCodes.length > 0 ||
    filters.cities.length > 0 ||
    filters.ips.length > 0 ||
    filters.ipsExclude.length > 0 ||
    filters.hostnames.length > 0
  )
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
