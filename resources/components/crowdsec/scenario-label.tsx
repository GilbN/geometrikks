import { Badge } from "@/components/ui/badge"
import { scenarioName } from "@/lib/scenario-name"
import { cn } from "@/lib/utils"

/**
 * A scenario's short name, its author when that isn't crowdsecurity, and a
 * manual decision's own reason. The full id stays in the tooltip. Pass the
 * origins the row already shows so an author that matches one isn't repeated.
 */
export function ScenarioLabel({
  scenario,
  shownOrigins,
  className,
}: {
  scenario: string
  shownOrigins?: readonly string[]
  className?: string
}) {
  const { name, author, reason } = scenarioName(scenario)
  const showAuthor = author !== null && !shownOrigins?.includes(author)
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={scenario}>
      <span className="min-w-12 truncate font-mono text-xs">{name}</span>
      {showAuthor && (
        <Badge variant="outline" className="min-w-0 max-w-28 shrink px-1.5 text-[10px] font-normal text-muted-foreground">
          <span className="truncate">{author}</span>
        </Badge>
      )}
      {reason && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{reason}</span>}
    </span>
  )
}
