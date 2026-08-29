import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SIGNAL_DESCRIPTIONS, type Signal, type SignalTone } from "./signals"

const TONE: Record<SignalTone, string> = {
  red: "border-destructive/40 bg-destructive/10 text-destructive",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  gray: "border-border bg-muted text-muted-foreground",
}

/** Renders nothing when no rule fired; a quiet IP has no strip. */
export function IpSignalsStrip({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Signals">
      {signals.map((s) => (
        <Tooltip key={s.key}>
          <TooltipTrigger asChild>
            <Badge variant="outline" tabIndex={0} className={cn("cursor-help font-medium", TONE[s.tone])}>
              {s.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{SIGNAL_DESCRIPTIONS[s.key]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
