import { MutedRetentionNote } from "@/components/data/muted-retention-note"
import { useCardChartGranularity } from "@/lib/queries"
import type { MutedScope } from "@/lib/muted-ips"
import { useMutedRetention } from "@/lib/use-muted-retention"

const THIRTY_DAYS_MS = 30 * 86_400_000

export function GeoLogsMutedNote({ scope }: { scope: MutedScope }) {
  const { active, days, rangeMs } = useMutedRetention(scope)
  const granularity = useCardChartGranularity()
  if (!active) return null
  const hourlyOverThirtyDays = granularity === "hourly" && rangeMs > THIRTY_DAYS_MS
  const items = hourlyOverThirtyDays ? ["the map", "the chart", "the card charts"] : ["the map"]
  return <MutedRetentionNote items={items} days={days} />
}
