/**
 * What a route puts in the phone header, declared as route staticData so the
 * root layout doesn't keep its own list of paths.
 */
import { useMatches } from "@tanstack/react-router"

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page follows the global time range: the phone header shows the
     *  range pill and the refresh button. */
    timeRange?: boolean
    /** The page draws time-series charts: the range drawer offers chart buckets. */
    chartBuckets?: boolean
  }
}

export function useRouteHeader(): { timeRange: boolean; chartBuckets: boolean } {
  const timeRange = useMatches({ select: (matches) => !!matches.at(-1)?.staticData.timeRange })
  const chartBuckets = useMatches({ select: (matches) => !!matches.at(-1)?.staticData.chartBuckets })
  return { timeRange, chartBuckets }
}
