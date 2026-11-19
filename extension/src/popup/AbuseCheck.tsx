import { useEffect, useState } from "react"
import { Loader2, RotateCw, ShieldQuestion } from "lucide-react"
import { BadgeHint } from "@/components/badge-hint"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CheckResponse } from "@/generated/api/types.gen"
import { abuseScoreTone, agoText, type AbuseScoreTone } from "@/lib/abuseipdb"
import { formatNumber } from "@/lib/format-number"
import { cn } from "@/lib/utils"
import type { ExtensionClient } from "../lib/client"
import { getAbuseCache, type ConnectionIdentity } from "../lib/storage"
import { checkAbuse } from "./lookup"

/** The app's `AbuseIpdbBadge` tones; that component runs its check through the app's query hooks. */
const TONE_CLASS: Record<AbuseScoreTone, string> = {
  high: "border-destructive/55 text-destructive",
  medium: "border-amber-500/55 text-amber-500",
  low: "text-muted-foreground",
}

export function AbuseScoreBadge({ result }: { result: CheckResponse }) {
  const reports = `${formatNumber(result.totalReports)} ${result.totalReports === 1 ? "report" : "reports"}`
  const label = [
    `AbuseIPDB ${result.abuseConfidenceScore}%`,
    reports,
    result.isTor ? "Tor" : null,
    result.isWhitelisted ? "whitelisted" : null,
  ]
  const title = [
    `${result.abuseConfidenceScore}% confidence from ${formatNumber(result.numDistinctUsers)} ${result.numDistinctUsers === 1 ? "reporter" : "reporters"}`,
    result.lastReportedAt
      ? `last reported ${agoText(result.lastReportedAt, Date.now())}`
      : "never reported",
    result.usageType,
  ]
  return (
    <BadgeHint hint={title.filter(Boolean).join(" · ")} hover="tooltip">
      <Badge
        variant="outline"
        className={cn(
          "h-auto max-w-full cursor-help text-left break-words whitespace-normal",
          TONE_CLASS[abuseScoreTone(result.abuseConfidenceScore)],
        )}
      >
        {label.filter(Boolean).join(" · ")}
      </Badge>
    </BadgeHint>
  )
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: CheckResponse }
  | { kind: "failed"; message: string }

/** A cached result shows as the badge; otherwise a button, because each
 *  check spends one of the server's daily AbuseIPDB lookups. */
export function AbuseCheck({
  ip,
  client,
  identity,
}: {
  ip: string
  client: ExtensionClient
  identity: ConnectionIdentity
}) {
  const [state, setState] = useState<CheckState | null>(null)
  const { origin, savedAt } = identity

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await getAbuseCache({ origin, savedAt }, ip)
      if (!cancelled) setState(cached ? { kind: "done", result: cached } : { kind: "idle" })
    })()
    return () => {
      cancelled = true
    }
  }, [ip, origin, savedAt])

  const run = async () => {
    setState({ kind: "checking" })
    const outcome = await checkAbuse(client, { origin, savedAt }, ip)
    setState(
      outcome.ok
        ? { kind: "done", result: outcome.result }
        : {
            kind: "failed",
            message: outcome.failure.detail ?? "The check failed; AbuseIPDB may be unreachable.",
          },
    )
  }

  if (state === null) return null
  if (state.kind === "done") return <AbuseScoreBadge result={state.result} />
  if (state.kind === "checking") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Loader2 aria-hidden className="animate-spin" />
        AbuseIPDB
      </Badge>
    )
  }
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        className="h-[22px] rounded-md px-[7px] text-[11.5px] font-medium text-muted-foreground"
        title="Spends one of today's AbuseIPDB checks"
        onClick={() => void run()}
      >
        {state.kind === "failed" ? <RotateCw /> : <ShieldQuestion />}
        {state.kind === "failed" ? "Retry AbuseIPDB check" : "Check AbuseIPDB"}
      </Button>
      {state.kind === "failed" && (
        <span role="alert" className="basis-full text-xs text-destructive">
          {state.message}
        </span>
      )}
    </>
  )
}
