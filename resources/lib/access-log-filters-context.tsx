/**
 * Shared filters for the access-logs history table. Like the geo-logs
 * filters and unlike the old component-local state, this lives in the URL
 * search params (shareable filter links): the /access-logs route computes
 * the filter state from its validated search and implements setFilters via
 * router.navigate, then mounts this provider as a plain conduit.
 */
import { createContext, useContext } from "react"

export interface AccessLogFilterState {
  /** Free-text search across url / referrer / user-agent. */
  search: string
  ips: string[]
  ipsExclude: string[]
  /** Exact HTTP Host values, chosen from the facets list. */
  hosts: string[]
  hostsExclude: string[]
  methods: string[]
  statusCodes: number[]
  cities: string[]
  countryCodes: string[]
}

export const EMPTY_ACCESS_LOG_FILTERS: AccessLogFilterState = {
  search: "",
  ips: [],
  ipsExclude: [],
  hosts: [],
  hostsExclude: [],
  methods: [],
  statusCodes: [],
  cities: [],
  countryCodes: [],
}

/** How many filter groups are set; drives the mobile drawer's badge. */
export function countActiveAccessLogFilters(filters: AccessLogFilterState): number {
  return (
    (filters.search ? 1 : 0) +
    (filters.ips.length ? 1 : 0) +
    (filters.ipsExclude.length ? 1 : 0) +
    (filters.hosts.length ? 1 : 0) +
    (filters.hostsExclude.length ? 1 : 0) +
    (filters.methods.length ? 1 : 0) +
    (filters.statusCodes.length ? 1 : 0) +
    (filters.cities.length ? 1 : 0) +
    (filters.countryCodes.length ? 1 : 0)
  )
}

export function hasActiveAccessLogFilters(filters: AccessLogFilterState): boolean {
  return countActiveAccessLogFilters(filters) > 0
}

interface AccessLogFiltersValue {
  filters: AccessLogFilterState
  setFilters: (updater: (prev: AccessLogFilterState) => AccessLogFilterState) => void
}

// Default = empty filters: the table keeps working outside the provider.
const AccessLogFiltersContext = createContext<AccessLogFiltersValue>({
  filters: EMPTY_ACCESS_LOG_FILTERS,
  setFilters: () => {},
})

export function AccessLogFiltersProvider({
  filters,
  setFilters,
  children,
}: AccessLogFiltersValue & { children: React.ReactNode }) {
  return (
    <AccessLogFiltersContext.Provider value={{ filters, setFilters }}>
      {children}
    </AccessLogFiltersContext.Provider>
  )
}

export function useAccessLogFilters() {
  return useContext(AccessLogFiltersContext)
}
