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
  const { data: stats, isPending } = useCrowdsecStats()

  // Skeletons only while genuinely loading. On a stats error the row must
  // still render: the LAPI card below is exactly the widget that has to
  // stay visible while the LAPI is down.
  if (!status || (isPending && !stats)) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  const localCount = stats
    ? stats.byOrigin
        .filter((o) => LOCAL_ORIGINS.has(o.origin))
        .reduce((sum, o) => sum + o.count, 0)
    : null
  const crowdCount = stats && localCount !== null ? stats.total - localCount : null
  const topScenario = stats?.topScenarios[0]

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Active decisions"
        value={stats ? stats.total.toLocaleString() : "-"}
        subtitle={
          crowdCount !== null ? `${crowdCount.toLocaleString()} from the crowd` : "unavailable"
        }
        icon={ShieldBan}
        iconClassName="text-red-400"
      />
      <StatCard
        title="Local bans"
        value={localCount !== null ? localCount.toLocaleString() : "-"}
        subtitle={localCount !== null ? "decided on this box" : "unavailable"}
        icon={UserRound}
      />
      <StatCard
        title="Top scenario"
        value={topScenario ? shortScenario(topScenario.scenario) : "-"}
        valueClassName="text-lg truncate"
        subtitle={
          topScenario
            ? `${topScenario.count.toLocaleString()} decisions`
            : stats
              ? "no decisions"
              : "unavailable"
        }
        icon={Radio}
      />
      <StatCard
        title="LAPI"
        value={status.lapiReachable ? "Connected" : "Unreachable"}
        valueClassName={status.lapiReachable ? "text-emerald-500" : "text-red-500"}
        subtitle={status.writeEnabled ? "ban/unban enabled" : "read-only (no machine credentials)"}
        icon={ShieldCheck}
        iconClassName={status.lapiReachable ? "text-emerald-500" : "text-red-500"}
      />
    </div>
  )
}

/** "crowdsecurity/ssh-bf" reads better as "ssh-bf" in a card. */
function shortScenario(scenario: string): string {
  return scenario.split("/").pop() ?? scenario
}
