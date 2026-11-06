import { useQuery } from "@tanstack/react-query"
import { fetchHealth } from "@/lib/api"
import { useInstances } from "@/lib/queries"
import {
  attentionSummary,
  sidebarIngestionVariant,
  sidebarStatusTooltip,
  type SidebarIngestionVariant,
} from "@/components/settings/status-logic"
import { agentsNeedingAttention } from "@/components/settings/agents-logic"

const INDICATOR_STYLES: Record<SidebarIngestionVariant, { color: string; label: string; tooltip: string }> = {
  offline: { color: "bg-gray-400", label: "Offline", tooltip: "Cannot connect to backend" },
  degraded: { color: "bg-amber-400", label: "Degraded", tooltip: "Service degraded - see Settings > Status" },
  attention: { color: "bg-amber-400", label: "Attention", tooltip: "Advisories need attention - see Settings > Status" },
  // Neutral, not amber: LOGPARSER_ENABLED=false is a deliberate setting
  // (UI-head deployments); other instances or agents write the data.
  disabled: { color: "bg-sidebar-foreground/30", label: "Ingestion off", tooltip: "Log tailing is turned off (LOGPARSER_ENABLED=false)" },
  running: { color: "bg-emerald-400", label: "Live ingestion", tooltip: "Live ingestion active" },
  inactive: { color: "bg-gray-400", label: "Inactive", tooltip: "Service status unknown" },
}

export function useServiceStatus(): {
  variant: SidebarIngestionVariant
  color: string
  label: string
  tooltip: string
  /** What needs attention, for degraded and attention only. */
  detail: string | null
  statusRoute: "/settings/status" | "/settings/agents"
  crowdsecDown: boolean
} {
  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10000, // Poll every 10 seconds
    retry: 1,
  })

  const { data: instances, isError: instancesError } = useInstances()
  // A failed refetch keeps the last answer cached, so without the isError
  // check the dot would keep reporting agents from a stale answer.
  const agentAttentionCount = instancesError ? 0 : agentsNeedingAttention(instances).length
  const headAdvisoryCount = health?.advisories?.length ?? 0

  const variant = sidebarIngestionVariant(health, isError, agentAttentionCount)
  const statusRoute =
    variant === "attention" && headAdvisoryCount === 0 ? "/settings/agents" : "/settings/status"

  const { color, label, tooltip: baseTooltip } = INDICATOR_STYLES[variant]
  const tooltip =
    variant === "degraded" || variant === "attention"
      ? sidebarStatusTooltip(baseTooltip, headAdvisoryCount, variant, agentAttentionCount)
      : baseTooltip

  const detail =
    variant === "degraded" || variant === "attention" ? attentionSummary(headAdvisoryCount, agentAttentionCount) : null

  const crowdsecDown =
    health?.crowdsec?.enabled === true && health.crowdsec.lapiReachable === false

  return { variant, color, label, tooltip, detail, statusRoute, crowdsecDown }
}
