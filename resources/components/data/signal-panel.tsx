import { useId } from "react"

import { ErrorBanner } from "@/components/error-banner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { FRAME_LABEL, FRAME_SURFACE } from "./frame"
import type { DataState } from "./types"

/**
 * One card around a chart: title, help text and actions in the header, the
 * chart (or its loading/error/empty stand-in) in the body, an optional
 * legend in the footer. `bodyClassName` sets the chart area's height so the
 * card keeps the same height in every state.
 */
export function SignalPanel({
  title,
  description,
  state,
  actions,
  legend,
  error = "The chart data could not be loaded.",
  onRetry,
  bodyClassName = "min-h-64",
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title" | "aria-labelledby"> & {
  title: string
  description?: string
  state: DataState
  actions?: React.ReactNode
  legend?: React.ReactNode
  error?: string
  onRetry?: () => void
  bodyClassName?: string
}) {
  const titleId = useId()
  return (
    <section
      data-slot="signal-panel"
      data-state={state}
      aria-labelledby={titleId}
      aria-busy={state === "loading"}
      className={cn(FRAME_SURFACE, className)}
      {...props}
    >
      <header className="flex min-w-0 flex-col gap-2 border-b border-border/50 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className={FRAME_LABEL}>
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">{actions}</div>}
      </header>

      <div className={cn("min-w-0 p-4", bodyClassName)}>
        {state === "loading" && <Skeleton className="h-full min-h-[inherit] w-full" aria-hidden />}
        {state === "error" && (
          <div className="space-y-3">
            <ErrorBanner title={error} />
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        )}
        {state === "empty" && (
          <div className="flex h-full min-h-[inherit] items-center justify-center text-center text-sm text-muted-foreground">
            No data for this range.
          </div>
        )}
        {state === "ready" && children}
      </div>

      {legend && (
        <footer className="border-t border-border/50 px-4 py-2.5 text-xs text-muted-foreground">{legend}</footer>
      )}
    </section>
  )
}
