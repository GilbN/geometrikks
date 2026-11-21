import { MutedRetentionNote } from "@/components/data/muted-retention-note"
import type { MutedScope } from "@/lib/muted-ips"
import { useMutedRetention } from "@/lib/use-muted-retention"

const ITEMS = [
  "the request, status, bandwidth and latency charts",
  "Top URLs",
  "user agents",
  "Top ASNs",
  "Traffic Origin",
]

export function AnalyticsMutedNote({ scope }: { scope: MutedScope }) {
  const { active, days } = useMutedRetention(scope)
  return active ? <MutedRetentionNote items={ITEMS} days={days} /> : null
}
