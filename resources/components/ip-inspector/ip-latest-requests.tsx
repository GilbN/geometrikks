import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/api"
import { formatTs } from "@/lib/datetime"
import { useIpLatestRequests } from "@/lib/queries"

export function IpLatestRequests({ ip }: { ip: string }) {
  const { data, isLoading, isError } = useIpLatestRequests(ip)
  const rows = data?.items ?? []
  if (!isLoading && !isError && rows.length === 0) return null
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Latest requests</h3>
      {isLoading && <Skeleton className="h-24 w-full" />}
      {isError && <p className="text-xs text-destructive">Could not load the latest requests.</p>}
      {rows.length > 0 && (
        <ul className="font-mono text-[11px]">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-2 py-0.5 tabular-nums">
              <span className="text-muted-foreground">{formatTs(r.timestamp, "hourly")}</span>
              <span className="truncate">{r.method ?? "?"} {r.url ?? ""}</span>
              <span className={r.statusCode >= 400 ? "text-amber-600 dark:text-amber-400" : ""}>{r.statusCode}</span>
              <span className="text-muted-foreground">{formatBytes(r.bytesSent)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
