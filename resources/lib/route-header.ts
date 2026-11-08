/**
 * What a route puts in the phone header, declared as route staticData so the
 * root layout doesn't keep its own list of paths.
 */
import { useMatches } from "@tanstack/react-router"

import type { CardChartsPage } from "@/lib/card-charts"

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page follows the global time range: the phone header shows the
     *  range pill and the refresh button. */
    timeRange?: boolean
    /** The page draws time-series charts: the range drawer offers chart buckets. */
    chartBuckets?: boolean
    /** The page's stat cards draw charts: the range drawer can turn them off. */
    cardCharts?: CardChartsPage
  }
}

export function useRouteHeader(): {
  timeRange: boolean
  chartBuckets: boolean
  cardCharts: CardChartsPage | undefined
} {
  const timeRange = useMatches({ select: (matches) => !!matches.at(-1)?.staticData.timeRange })
  const chartBuckets = useMatches({ select: (matches) => !!matches.at(-1)?.staticData.chartBuckets })
  const cardCharts = useMatches({ select: (matches) => matches.at(-1)?.staticData.cardCharts })
  return { timeRange, chartBuckets, cardCharts }
}
