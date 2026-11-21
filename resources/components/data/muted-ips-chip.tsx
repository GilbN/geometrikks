/** The Muted IPs switch on the log pages' filter rails. */
import { useId } from "react"
import { Eye, EyeOff } from "lucide-react"
import { FilterField } from "@/components/data/filter-rail"
import { Button } from "@/components/ui/button"
import type { MutedScope } from "@/lib/muted-ips"
import { cn } from "@/lib/utils"

const HIDING_BUTTON = "border-primary/50 text-primary dark:border-primary/50"

export function MutedIpsChip({ scope, onToggle }: { scope: MutedScope; onToggle: () => void }) {
  const hintId = useId()
  if (scope.chip === "none") return null
  const greyed = scope.chip === "greyed"
  const hiding = scope.chip === "hiding"
  const label = hiding && scope.count !== null ? `Muted IPs hidden · ${scope.count}` : null
  return (
    <FilterField label="Muted IPs" group>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={greyed ? undefined : hiding}
          aria-describedby={greyed ? hintId : undefined}
          disabled={greyed}
          onClick={onToggle}
          className={cn("h-8 text-xs", hiding && HIDING_BUTTON)}
        >
          {scope.chip === "shown" ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          {scope.chip === "shown" ? "Muted IPs shown" : (label ?? "Muted IPs hidden")}
        </Button>
        {greyed && (
          <span id={hintId} className="text-xs text-muted-foreground">
            Off while filtering by IP
          </span>
        )}
      </div>
    </FilterField>
  )
}
