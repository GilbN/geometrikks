/**
 * Shared country/city/IP filters for the analytics page. Threaded into the
 * six analytics hooks (time-series, top-urls, top-user-agents, top-ips,
 * top-country-stats, top-city-stats) so the filter bar reshapes every chart
 * and top-list at once.
 */
import { createContext, useContext, useState } from "react"

export interface AnalyticsFilterState {
  countryCodes: string[]
  cities: string[]
  ips: string[]
}

export const EMPTY_FILTERS: AnalyticsFilterState = { countryCodes: [], cities: [], ips: [] }

interface AnalyticsFiltersValue {
  filters: AnalyticsFilterState
  setFilters: React.Dispatch<React.SetStateAction<AnalyticsFilterState>>
}

// Default = empty filters: hooks shared with the dashboard keep working
// outside the provider.
const AnalyticsFiltersContext = createContext<AnalyticsFiltersValue>({
  filters: EMPTY_FILTERS,
  setFilters: () => {},
})

export function AnalyticsFiltersProvider({ children }: { children: React.ReactNode }) {
  const [filters, setFilters] = useState<AnalyticsFilterState>(EMPTY_FILTERS)
  return (
    <AnalyticsFiltersContext.Provider value={{ filters, setFilters }}>
      {children}
    </AnalyticsFiltersContext.Provider>
  )
}

export function useAnalyticsFilters() {
  return useContext(AnalyticsFiltersContext)
}
