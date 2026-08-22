/**
 * Shared country/city/IP-include/IP-exclude filters for the analytics page.
 * Threaded into the seven analytics hooks (time-series, top-urls,
 * top-user-agents, top-asns, top-ips, top-country-stats, top-city-stats) so
 * the filter bar reshapes every chart and top-list at once.
 *
 * Like the geo-logs filters, the state itself lives in the URL search params
 * (shareable filter links): the /analytics route computes it from its
 * validated search and implements setFilters via router.navigate, then
 * mounts this provider as a plain conduit.
 */
import { createContext, useContext } from "react"

export interface AnalyticsFilterState {
  countryCodes: string[]
  cities: string[]
  ips: string[]
  ipsExclude: string[]
}

export const EMPTY_FILTERS: AnalyticsFilterState = {
  countryCodes: [],
  cities: [],
  ips: [],
  ipsExclude: [],
}

export function hasActiveAnalyticsFilters(filters: AnalyticsFilterState): boolean {
  return (
    filters.countryCodes.length > 0 ||
    filters.cities.length > 0 ||
    filters.ips.length > 0 ||
    filters.ipsExclude.length > 0
  )
}

interface AnalyticsFiltersValue {
  filters: AnalyticsFilterState
  setFilters: (updater: (prev: AnalyticsFilterState) => AnalyticsFilterState) => void
}

// Default = empty filters: hooks shared with the dashboard keep working
// outside the provider. This contract must not break.
const AnalyticsFiltersContext = createContext<AnalyticsFiltersValue>({
  filters: EMPTY_FILTERS,
  setFilters: () => {},
})

export function AnalyticsFiltersProvider({
  filters,
  setFilters,
  children,
}: AnalyticsFiltersValue & { children: React.ReactNode }) {
  return (
    <AnalyticsFiltersContext.Provider value={{ filters, setFilters }}>
      {children}
    </AnalyticsFiltersContext.Provider>
  )
}

export function useAnalyticsFilters() {
  return useContext(AnalyticsFiltersContext)
}
