/**
 * An IP's AbuseIPDB score in the inspector header. The lookup runs when the
 * inspector opens and spends one of the day's checks, at most once per IP
 * every 15 minutes.
 */
import { Loader2 } from "lucide-react"
import { BadgeHint } from "@/components/badge-hint"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { errorDetail } from "@/lib/abuse-report"
import { formatNumber } from "@/lib/api"
import { abuseScoreTone, agoText, type AbuseScoreTone } from "@/lib/abuseipdb"
import { useAbuseIpdbCheck } from "@/lib/queries"
import { cn } from "@/lib/utils"

const TONE_CLASS: Record<AbuseScoreTone, string> = {
  high: "border-destructive/55 text-destructive",
  medium: "border-amber-500/55 text-amber-500",
  low: "text-muted-foreground",
}

export function AbuseIpdbBadge({ ip }: { ip: string }) {
  const check = useAbuseIpdbCheck(ip, true)
  const result = check.data

  if (check.isError) {
    return (
      <>
        <Button variant="outline" size="xs" disabled={check.isFetching} onClick={() => void check.refetch()}>
          Retry AbuseIPDB check
        </Button>
        <span className="text-xs text-red-500">{errorDetail(check.error, "The check failed; AbuseIPDB may be unreachable.")}</span>
      </>
    )
  }

  if (result) {
    const reports = `${formatNumber(result.totalReports)} ${result.totalReports === 1 ? "report" : "reports"}`
    const label = [
      `AbuseIPDB ${result.abuseConfidenceScore}%`,
      reports,
      result.isTor ? "Tor" : null,
      result.isWhitelisted ? "whitelisted" : null,
    ]
    const title = [
      `${result.abuseConfidenceScore}% confidence from ${formatNumber(result.numDistinctUsers)} ${result.numDistinctUsers === 1 ? "user" : "users"}`,
      result.lastReportedAt ? `last reported ${agoText(result.lastReportedAt, Date.now())}` : "never reported",
      result.usageType,
    ]
    return (
      <BadgeHint hint={title.filter(Boolean).join(" · ")}>
        <Badge
          variant="outline"
          className={cn("h-auto max-w-full whitespace-normal break-words text-left", TONE_CLASS[abuseScoreTone(result.abuseConfidenceScore)])}
        >
          {label.filter(Boolean).join(" · ")}
        </Badge>
      </BadgeHint>
    )
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Loader2 aria-hidden className="animate-spin" />
      AbuseIPDB
    </Badge>
  )
}
