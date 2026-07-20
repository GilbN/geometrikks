/**
 * Security stat cards: decision totals split by who decided (the crowd vs.
 * this box) plus LAPI connection state. Fed by /crowdsec/stats and /status.
 */
import { Radio, ShieldBan, ShieldCheck, UserRound } from "lucide-react"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { useCrowdsecStats, useCrowdsecStatus } from "@/lib/queries"

/** Origins created on this box rather than pulled from the crowd. */
const LOCAL_ORIGINS = new Set(["crowdsec", "cscli", "geometrikks"])

export function SecurityStatCards() {
  const { data: status } = useCrowdsecStatus()
  const { data: stats, isLoading } = useCrowdsecStats()

  if (isLoading || !stats || !status) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  const localCount = stats.by_origin
    .filter((o) => LOCAL_ORIGINS.has(o.origin))
    .reduce((sum, o) => sum + o.count, 0)
  const crowdCount = stats.total - localCount
  const topScenario = stats.top_scenarios[0]

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Active decisions"
        value={stats.total.toLocaleString()}
        subtitle={`${crowdCount.toLocaleString()} from the crowd`}
        icon={ShieldBan}
        iconClassName="text-red-400"
      />
      <StatCard
        title="Local bans"
        value={localCount.toLocaleString()}
        subtitle="decided on this box"
        icon={UserRound}
      />
      <StatCard
        title="Top scenario"
        value={topScenario ? shortScenario(topScenario.scenario) : "-"}
        valueClassName="text-lg truncate"
        subtitle={
          topScenario ? `${topScenario.count.toLocaleString()} decisions` : "no decisions"
        }
        icon={Radio}
      />
      <StatCard
        title="LAPI"
        value={status.lapi_reachable ? "Connected" : "Unreachable"}
        valueClassName={status.lapi_reachable ? "text-emerald-500" : "text-red-500"}
        subtitle={status.write_enabled ? "ban/unban enabled" : "read-only (no machine credentials)"}
        icon={ShieldCheck}
        iconClassName={status.lapi_reachable ? "text-emerald-500" : "text-red-500"}
      />
    </div>
  )
}

/** "crowdsecurity/ssh-bf" reads better as "ssh-bf" in a card. */
function shortScenario(scenario: string): string {
  return scenario.split("/").pop() ?? scenario
}
