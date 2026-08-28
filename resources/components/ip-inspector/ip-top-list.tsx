import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface TopRow {
  label: string
  hits: number
  errorHits?: number
  mono?: boolean
}

/** Targets, paths and user agents share this: label, optional share bar,
 *  count. `bars` draws a proportional bar under each row (targets). */
export function IpTopList({ title, rows, bars = false }: { title: string; rows: TopRow[]; bars?: boolean }) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((r) => r.hits))
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="text-xs">
            <div className="flex items-center justify-between gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn("min-w-0 truncate", r.mono && "font-mono")}>{r.label}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm break-all">
                  {r.label}
                  {r.errorHits !== undefined && ` · ${formatNumber(r.errorHits)} errors`}
                </TooltipContent>
              </Tooltip>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(r.hits)}</span>
            </div>
            {bars && (
              <div className="mt-0.5 h-1 rounded-full bg-muted">
                <div className="h-full rounded-full bg-[var(--chart-1)]/70" style={{ width: `${(r.hits / max) * 100}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
