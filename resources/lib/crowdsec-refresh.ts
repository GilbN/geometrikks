import type { QueryClient } from "@tanstack/react-query"

/** The CrowdSec queries a ban or unban waits on. Alerts per day is left out,
 *  because its fetch reads up to 2000 alerts and would keep the dialog or the
 *  row controls pending long after the ban landed. */
export const AWAITED_CROWDSEC_QUERIES = {
  queryKey: ["crowdsec"],
  predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[1] !== "alerts-per-day",
} as const

/** Refreshes every CrowdSec query after a ban or unban. The returned promise
 *  covers only AWAITED_CROWDSEC_QUERIES. */
export function refreshCrowdsecAfterWrite(queryClient: QueryClient): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: ["crowdsec", "alerts-per-day"] })
  return queryClient.invalidateQueries(AWAITED_CROWDSEC_QUERIES)
}
