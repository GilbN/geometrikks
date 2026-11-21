import { MutedRetentionNote } from "@/components/data/muted-retention-note"
import { useCardCharts } from "@/lib/card-charts"
import { useCardChartGranularity } from "@/lib/queries"
import type { MutedScope } from "@/lib/muted-ips"
import { useMutedRetention } from "@/lib/use-muted-retention"

const THIRTY_DAYS_MS = 30 * 86_400_000

export function GeoLogsMutedNote({ scope }: { scope: MutedScope }) {
  const { active, days, rangeMs } = useMutedRetention(scope)
  const granularity = useCardChartGranularity()
  const [cardChartsOn] = useCardCharts("geo-logs")
  if (!active) return null
  const hourlyOverThirtyDays = granularity === "hourly" && rangeMs > THIRTY_DAYS_MS
  const items = ["the map"]
  if (hourlyOverThirtyDays) items.push("the chart")
  if (hourlyOverThirtyDays && cardChartsOn) items.push("the card charts")
  return <MutedRetentionNote items={items} days={days} />
}
