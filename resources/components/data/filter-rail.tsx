import { useId } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FRAME_LABEL, FRAME_SURFACE } from "./frame"

/**
 * Bounded desktop container for a page's filters: label, active-group count
 * and a Clear action. `activeCount` counts logical groups (one per populated
 * multi-select or text field), never individual chips.
 */
export function FilterRail({
  label,
  activeCount = 0,
  onClear,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "aria-labelledby"> & {
  label: string
  activeCount?: number
  onClear?: () => void
}) {
  const labelId = useId()
  return (
    <div
      data-slot="filter-rail"
      role="region"
      aria-labelledby={labelId}
      className={cn(FRAME_SURFACE, "flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center", className)}
      {...props}
    >
      <div className="flex shrink-0 items-center gap-2">
        <span id={labelId} className={FRAME_LABEL}>
          {label}
        </span>
        {activeCount > 0 && (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium tabular-nums text-primary">
            <span className="sr-only">Active filter groups: </span>
            {activeCount}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {onClear && activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-8 self-start pointer-coarse:h-11 sm:self-auto"
        >
          Clear filters
        </Button>
      )}
    </div>
  )
}
